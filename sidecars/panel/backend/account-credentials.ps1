$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$utf8 = [Console]::OutputEncoding

function Test-AccountFile($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Invalid account file'
    }
    return $true
}

function Write-AccountFile($path, [byte[]]$bytes) {
    $temp = Join-Path ([IO.Path]::GetDirectoryName($path)) ([guid]::NewGuid().ToString() + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temp, $bytes)
        if (Test-AccountFile $path) {
            [IO.File]::Replace($temp, $path, [NullString]::Value)
        } else {
            [IO.File]::Move($temp, $path)
        }
    } finally {
        [IO.File]::Delete($temp)
    }
}

function Save-Vault($path, $vault) {
    $bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $vault -Depth 4 -Compress))
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
    Write-AccountFile $path $encrypted
}

function Add-NativeCredentialType {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NativeAccountCredential {
    private const uint Generic = 1;
    private const uint PersistLocalMachine = 2;
    private const int NotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static byte[] Read(string target) {
        IntPtr pointer;
        if (!CredReadW(target, Generic, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }
        try {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            var bytes = new byte[credential.BlobSize];
            if (bytes.Length > 0) Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
            return bytes;
        } finally {
            CredFree(pointer);
        }
    }

    public static void Write(string target, byte[] bytes) {
        var buffer = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            var credential = new Credential {
                Type = Generic, Persist = PersistLocalMachine, TargetName = target,
                UserName = "antigravity", Blob = buffer.AddrOfPinnedObject(), BlobSize = (uint)bytes.Length
            };
            if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            buffer.Free();
        }
    }

    public static void Restore(string target, byte[] bytes) {
        if (bytes != null) Write(target, bytes);
        else if (!CredDeleteW(target, Generic, 0)) {
            int error = Marshal.GetLastWin32Error();
            if (error != NotFound) throw new Win32Exception(error);
        }
    }
}
'@
}

function Invoke-AccountAction($request) {
    Add-Type -AssemblyName System.Security
    $vault = @{ entries = @(); selectedEmail = '' }
    if (Test-AccountFile $request.vault) {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($request.vault), $null, 'CurrentUser')
        $vault = ConvertFrom-Json -InputObject ($utf8.GetString($plain))
    }
    $entry = $vault.entries | Where-Object { $_.email -eq $request.email } | Select-Object -First 1
    if ($null -ne $request.expectedCredential -and $entry.credential -cne $request.expectedCredential) {
        return @{ error = 'credentialChanged' }
    }

    switch ($request.action) {
        'readCurrent' {
            Add-NativeCredentialType
            $bytes = [NativeAccountCredential]::Read($request.target)
            if (-not $bytes) {
                foreach ($path in $request.fallbacks) {
                    if (Test-AccountFile $path) {
                        $bytes = [IO.File]::ReadAllBytes($path)
                        if ($bytes) { break }
                    }
                }
            }
            if (-not $bytes) { return @{ error = 'noCurrentCredential' } }
            return @{ credential = $utf8.GetString($bytes).TrimStart([char]0xfeff).Trim() }
        }
        'read' {
            if (-not $entry) { return @{ error = 'notFound' } }
            return @{ credential = $entry.credential }
        }
        'save' {
            if ($entry) { $entry.credential = $request.credential }
            else { $vault.entries = @($vault.entries) + @(@{ email = $request.email; credential = $request.credential }) }
            Save-Vault $request.vault $vault
        }
        'switch' {
            if (-not $entry) { return @{ error = 'notFound' } }
            $replacement = $utf8.GetBytes($request.credential)
            if ($replacement.Length -gt 2560) { return @{ error = 'credentialTooLarge' } }
            Add-NativeCredentialType
            $previous = [NativeAccountCredential]::Read($request.target)
            $fallbacks = @(foreach ($path in $request.fallbacks) {
                if (Test-AccountFile $path) { @{ path = $path; original = [IO.File]::ReadAllBytes($path) } }
            })
            $written = @()
            [NativeAccountCredential]::Write($request.target, $replacement)
            try {
                foreach ($fallback in $fallbacks) {
                    Write-AccountFile $fallback.path $replacement
                    $written += $fallback
                }
                $entry.credential = $request.credential
                $vault.selectedEmail = $request.email
                Save-Vault $request.vault $vault
            } catch {
                $restored = $true
                try { [NativeAccountCredential]::Restore($request.target, $previous) } catch { $restored = $false }
                foreach ($fallback in $written) {
                    try { Write-AccountFile $fallback.path $fallback.original } catch { $restored = $false }
                }
                if (-not $restored) { return @{ error = 'rollbackFailed' } }
                throw
            }
        }
        'remove' {
            if (-not $entry) { return @{ error = 'notFound' } }
            $vault.entries = @($vault.entries | Where-Object { $_.email -ne $request.email })
            if ($vault.selectedEmail -eq $request.email) { $vault.selectedEmail = '' }
            Save-Vault $request.vault $vault
        }
    }
    return @{ accounts = @($vault.entries | ForEach-Object { $_.email }); selectedEmail = $vault.selectedEmail }
}

$mutex = $null
$locked = $false
try {
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    $mutex = [Threading.Mutex]::new($false, 'Local\AntigravityUsageMonitor.AccountCredentials')
    try { $locked = $mutex.WaitOne(4000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    $result = if ($locked) { Invoke-AccountAction $request } else { @{ error = 'busy' } }
} catch {
    $result = @{ error = 'storeFailed' }
    $nativeError = $_.Exception.InnerException
    if ($nativeError -is [ComponentModel.Win32Exception] -and $nativeError.NativeErrorCode -in 5, 1312) {
        $result.error = 'credentialAccessDenied'
    }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
[Console]::Write((ConvertTo-Json -InputObject $result -Compress))
