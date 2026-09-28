param([Parameter(Mandatory = $true)][string]$Target)

$source = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct RouterCredential {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
}

public static class RouterCredentialApi {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredReadW")]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    public static extern void CredFree(IntPtr credential);
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop

$pointer = [IntPtr]::Zero
if (-not [RouterCredentialApi]::CredRead($Target, 1, 0, [ref]$pointer)) { exit 2 }
try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][RouterCredential])
    if ($credential.CredentialBlobSize -lt 1 -or $credential.CredentialBlobSize -gt 4096) { exit 3 }
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    $utf16 = $bytes.Length % 2 -eq 0
    if ($utf16) {
        for ($index = 1; $index -lt $bytes.Length; $index += 2) {
            if ($bytes[$index] -ne 0) { $utf16 = $false; break }
        }
    }
    $value = if ($utf16) { [Text.Encoding]::Unicode.GetString($bytes) }
        else { [Text.Encoding]::UTF8.GetString($bytes) }
    [Console]::Out.Write($value.TrimEnd([char]0))
    [Array]::Clear($bytes, 0, $bytes.Length)
} finally {
    [RouterCredentialApi]::CredFree($pointer)
}
