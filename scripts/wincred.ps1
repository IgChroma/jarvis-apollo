# Secretos de Jarvis en el Administrador de credenciales de Windows: el
# equivalente del Llavero de macOS. Lo usan lib.sh, check-leaks.py y el
# simulador; no hace falta llamarlo a mano (para eso está scripts/secrets.sh).
#
#   wincred.ps1 dump    SERVICIO           NOMBRE<TAB>valor-en-base64, uno por línea
#   wincred.ps1 put     SERVICIO NOMBRE    guarda el valor que llega por stdin
#   wincred.ps1 delete  SERVICIO NOMBRE
#
# Cada secreto es una credencial genérica "SERVICIO.NOMBRE" con usuario NOMBRE
# (Panel de control > Administrador de credenciales > Credenciales de Windows).
# El valor viaja SOLO por stdin/stdout, nunca como argumento: quedaría a la vista
# en la lista de procesos.
param(
    [Parameter(Mandatory = $true)][ValidateSet('dump', 'put', 'delete')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Service,
    [string]$Name
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class JarvisCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    const int CRED_TYPE_GENERIC = 1;
    const int CRED_PERSIST_LOCAL_MACHINE = 2;
    const int ERROR_NOT_FOUND = 1168;
    public const int MaxBlobBytes = 5 * 512;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDeleteW(string target, int type, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredEnumerateW(string filter, int flags, out int count, out IntPtr credentials);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    public static void Write(string target, string user, byte[] blob) {
        if (blob.Length > MaxBlobBytes) {
            throw new ArgumentException("El valor ocupa " + blob.Length + " bytes; Windows admite hasta " + MaxBlobBytes + ".");
        }
        IntPtr buffer = Marshal.AllocHGlobal(Math.Max(blob.Length, 1));
        try {
            Marshal.Copy(blob, 0, buffer, blob.Length);
            CREDENTIAL credential = new CREDENTIAL();
            credential.Type = CRED_TYPE_GENERIC;
            credential.TargetName = target;
            credential.UserName = user;
            credential.CredentialBlob = buffer;
            credential.CredentialBlobSize = blob.Length;
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            if (!CredWriteW(ref credential, 0)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        } finally {
            for (int index = 0; index < blob.Length; index++) {
                Marshal.WriteByte(buffer, index, 0);
            }
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static bool Delete(string target) {
        if (CredDeleteW(target, CRED_TYPE_GENERIC, 0)) {
            return true;
        }
        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_NOT_FOUND) {
            return false;
        }
        throw new System.ComponentModel.Win32Exception(error);
    }

    // TargetName -> valor, de todas las credenciales que empiezan con prefix.
    public static Dictionary<string, byte[]> ReadAll(string prefix) {
        Dictionary<string, byte[]> found = new Dictionary<string, byte[]>();
        int count;
        IntPtr list;
        if (!CredEnumerateW(prefix + "*", 0, out count, out list)) {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_NOT_FOUND) {
                return found;
            }
            throw new System.ComponentModel.Win32Exception(error);
        }
        try {
            for (int index = 0; index < count; index++) {
                IntPtr item = Marshal.ReadIntPtr(list, index * IntPtr.Size);
                CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
                if (credential.Type != CRED_TYPE_GENERIC) {
                    continue;
                }
                byte[] blob = new byte[credential.CredentialBlobSize];
                if (blob.Length > 0) {
                    Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
                }
                found[credential.TargetName] = blob;
            }
        } finally {
            CredFree(list);
        }
        return found;
    }
}
'@

$prefix = "$Service."
$utf8 = New-Object System.Text.UTF8Encoding($false)

switch ($Action) {
    'dump' {
        $stdout = [Console]::OpenStandardOutput()
        foreach ($entry in [JarvisCred]::ReadAll($prefix).GetEnumerator()) {
            $line = $entry.Key.Substring($prefix.Length) + "`t" + [Convert]::ToBase64String($entry.Value) + "`n"
            $bytes = $utf8.GetBytes($line)
            $stdout.Write($bytes, 0, $bytes.Length)
        }
        $stdout.Flush()
    }
    'put' {
        if (-not $Name) { throw 'Falta NOMBRE.' }
        $stdin = [Console]::OpenStandardInput()
        $memory = New-Object System.IO.MemoryStream
        $stdin.CopyTo($memory)
        [JarvisCred]::Write($prefix + $Name, $Name, $memory.ToArray())
    }
    'delete' {
        if (-not $Name) { throw 'Falta NOMBRE.' }
        if (-not [JarvisCred]::Delete($prefix + $Name)) { exit 1 }
    }
}
