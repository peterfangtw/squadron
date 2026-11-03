using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class PrivateFilesFixture {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int size, IntPtr output, int outputSize, out uint returned, IntPtr overlap);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlap);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetOverlappedResult(SafeFileHandle handle, IntPtr overlap, out uint transferred, bool wait);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint QueryDosDevice(string name, StringBuilder target, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DefineDosDevice(uint flags, string name, string target);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string path, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [StructLayout(LayoutKind.Sequential)] struct Overlap { internal IntPtr Internal, High; internal uint Offset, OffsetHigh; internal IntPtr Event; }
  public static int Main(string[] args) {
    string sid;
    using (var identity = WindowsIdentity.GetCurrent()) sid = identity.User.Value;
    if (args[0] == "owner") {
      string owner = File.GetAccessControl(args[1], AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)).Value;
      Console.WriteLine("{\"caller\":\"" + sid + "\",\"owner\":\"" + owner + "\"}");
      return 0;
    }
    if (args[0] == "drive") {
      var target = new StringBuilder(32768);
      if (QueryDosDevice(Path.GetPathRoot(args[1]).Substring(0, 2), target, target.Capacity) == 0) return 51;
      string alias = null;
      for (char letter = 'Z'; letter >= 'D'; letter--) {
        var existing = new StringBuilder(32768);
        if (QueryDosDevice(letter + ":", existing, existing.Capacity) == 0 && Marshal.GetLastWin32Error() == 2) { alias = letter + ":"; break; }
      }
      if (alias == null) return 52;
      string original = target.ToString(), replacement = "\\??\\" + Path.Combine(args[1], "remapped-root");
      string suffix = args[1].Substring(3), filename = "drive-original";
      string wrongParent = Path.Combine(args[1], "remapped-root", suffix);
      Directory.CreateDirectory(wrongParent); File.WriteAllText(Path.Combine(wrongParent, filename), "wrong-object");
      bool added = false, remapped = false;
      try {
        if (!DefineDosDevice(9, alias, original)) return 53;
        added = true;
        string name = alias + "\\" + suffix + "\\" + filename;
        using (var chain = new Squadron.PrivateFiles.Chain(name)) {
          using (var held = chain.Open(false, false, false)) Squadron.PrivateFiles.Native.Inspect(held, "managed", chain.Target);
          if (!DefineDosDevice(9, alias, replacement)) return 54;
          remapped = true;
          if (File.ReadAllText(name) != "wrong-object") return 55;
          bool refused = false;
          try { using (var held = chain.Open(false, false, false)) { } }
          catch (Exception error) { if (error is System.ComponentModel.Win32Exception || error is Squadron.PrivateFiles.Refusal) refused = true; else throw; }
          Console.WriteLine("{\"originalOpened\":true,\"aliasNowNamesWrongObject\":true,\"refused\":" + (refused ? "true" : "false") + "}");
          return refused ? 0 : 56;
        }
      } finally {
        if (remapped && !DefineDosDevice(15, alias, replacement)) throw new Exception("restore remap");
        if (added && !DefineDosDevice(15, alias, original)) throw new Exception("restore alias");
      }
    }
    if (args[0] == "oplock") {
      using (var handle = CreateFileW(args[1], 0x80000000, 7, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero))
      using (var broken = new EventWaitHandle(false, EventResetMode.ManualReset)) {
        if (handle.IsInvalid) return Marshal.GetLastWin32Error();
        IntPtr overlap = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlap)));
        try {
          Marshal.StructureToPtr(new Overlap { Event = broken.SafeWaitHandle.DangerousGetHandle() }, overlap, false);
          uint returned;
          if (DeviceIoControl(handle, 0x90000, null, 0, IntPtr.Zero, 0, out returned, overlap) || Marshal.GetLastWin32Error() != 997) return 23;
          Console.WriteLine("ready"); Console.Out.Flush();
          if (!broken.WaitOne(5000)) return 24;
          if (!GetOverlappedResult(handle, overlap, out returned, true)) return 25;
          Console.WriteLine("break"); Console.Out.Flush();
          var released = new ManualResetEvent(false);
          new Thread(delegate() { Console.ReadLine(); released.Set(); }) { IsBackground = true }.Start();
          if (!released.WaitOne(5000)) return 26;
        } finally {
          CancelIoEx(handle, overlap);
          uint ignored; GetOverlappedResult(handle, overlap, out ignored, true);
          Marshal.FreeHGlobal(overlap);
        }
      }
      return 0;
    }
    if (args[0] == "relative") {
      string parent = Path.Combine(args[1], "race"), destination = Path.Combine(args[1], "destination");
      Directory.CreateDirectory(parent); Directory.CreateDirectory(destination);
      using (var write = CreateFileW(parent, 0x40000000, 7, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero))
      using (var anchor = CreateFileW(parent, 0x20080, 3, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero)) {
        if (write.IsInvalid || anchor.IsInvalid) return 20;
        var substitute = Encoding.Unicode.GetBytes("\\??\\" + destination);
        var print = Encoding.Unicode.GetBytes(destination);
        var bytes = new byte[20 + substitute.Length + print.Length];
        Array.Copy(BitConverter.GetBytes(0xa0000003U), 0, bytes, 0, 4);
        Array.Copy(BitConverter.GetBytes((ushort)(bytes.Length - 8)), 0, bytes, 4, 2);
        Array.Copy(BitConverter.GetBytes((ushort)substitute.Length), 0, bytes, 10, 2);
        Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, bytes, 12, 2);
        Array.Copy(BitConverter.GetBytes((ushort)print.Length), 0, bytes, 14, 2);
        Array.Copy(substitute, 0, bytes, 16, substitute.Length); Array.Copy(print, 0, bytes, 18 + substitute.Length, print.Length);
        uint returned;
        if (!DeviceIoControl(write, 0x900a4, bytes, bytes.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero)) return 21;
        int refused = 0;
        try {
          try { using (var child = Squadron.PrivateFiles.Native.Relative(anchor, "must-not-redirect", 0xc0120000, 7, 2, false, true)) { } }
          catch (System.ComponentModel.Win32Exception error) { refused = error.NativeErrorCode; }
        } finally {
          var remove = new byte[8]; Array.Copy(BitConverter.GetBytes(0xa0000003U), remove, 4);
          if (!DeviceIoControl(write, 0x900ac, remove, remove.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero)) throw new Exception("restore");
        }
        bool redirected = File.Exists(Path.Combine(destination, "must-not-redirect"));
        Console.WriteLine("{\"refused\":" + refused + ",\"redirected\":" + (redirected ? "true" : "false") + ",\"restored\":true}");
        return refused == 1921 && !redirected ? 0 : 22;
      }
    }
    if (args[0] == "lock") {
      using (var handle = CreateFileW(args[1], 0x40000000, 7, IntPtr.Zero, 3, 0x2000000, IntPtr.Zero)) {
        if (handle.IsInvalid) return Marshal.GetLastWin32Error();
        Console.WriteLine("ready"); Console.Out.Flush(); Console.ReadLine();
      }
      return 0;
    }
    string sddl = args[2].Replace("USER", sid);
    var security = new RawSecurityDescriptor(sddl);
    var descriptorBytes = new byte[security.BinaryLength]; security.GetBinaryForm(descriptorBytes, 0);
    IntPtr descriptor = Marshal.AllocHGlobal(descriptorBytes.Length);
    try {
      Marshal.Copy(descriptorBytes, 0, descriptor, descriptorBytes.Length);
      bool present, defaulted; IntPtr dacl;
      if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      string descriptorPath = args[1].StartsWith(@"\\?\", StringComparison.Ordinal) ? args[1] : @"\\?\" + args[1];
      uint protection = (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? 0x80000000U : 0x20000000U;
      uint result = SetNamedSecurityInfoW(descriptorPath, 1, 4 | protection, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (result != 0) throw new System.ComponentModel.Win32Exception((int)result, "fixture DACL update: " + result);
    } finally { Marshal.FreeHGlobal(descriptor); }
    Console.WriteLine(sid);
    return 0;
  }
}
