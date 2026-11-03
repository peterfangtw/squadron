using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Squadron.PrivateFiles {
  internal static class Program {
    internal const int ControlLimit = 98304, ChunkLimit = 65536;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly Stream Input = Console.OpenStandardInput(), Output = Console.OpenStandardOutput();
    static readonly ManualResetEvent Finished = new ManualResetEvent(false);
    static long progress, expires;
    static IntPtr owner;
    static string nonce, token;
    static Thread watchdog;
    static readonly Queue<byte[]> Frames = new Queue<byte[]>();
    static readonly AutoResetEvent FrameReady = new AutoResetEvent(false);
    static readonly Semaphore FrameSpace = new Semaphore(1, 1);

    public static int Main(string[] args) {
      try {
        progress = Clock.ElapsedMilliseconds;
        watchdog = new Thread(Watch) { IsBackground = true };
        watchdog.Start();
        Require(Native.Target(), "target");
        using (var impersonation = WindowsIdentity.GetCurrent(true)) Require(impersonation == null, "impersonation");
        if (args.Length == 2 && args[0] == "identity") {
          int pid = PositiveInt(args[1]);
          using (var caller = new Owner(pid, null)) {
            Reply("1\nidentity\n" + pid + "\n" + caller.Birth + "\n" + Native.Sid());
          }
          return 0;
        }
        if (args.Length == 3 && args[0] == "directory") {
          int pid = PositiveInt(args[1]);
          using (var caller = new Owner(pid, null)) {
            owner = caller.Handle;
            string target = args[2].TrimEnd('\\') + "\\squadron-incoming-" + Native.Sid();
            using (var chain = new Chain(target)) chain.Validate();
            Reply("1\ndirectory\n" + pid + "\n" + caller.Birth + "\n" + Native.Sid() + "\n" + target);
          }
          return 0;
        }
        Require(args.Length == 0, "arguments");
        new Thread(Pump) { IsBackground = true }.Start();
        var start = Control().Split('\n');
        Require(start.Length == 9 && start[0] == "1", "protocol");
        nonce = start[1];
        Require(Regex.IsMatch(nonce, "\\A[0-9a-f]{32}\\z"), "nonce");
        int ownerPid = PositiveInt(start[2]);
        Require(Regex.IsMatch(start[3], "\\A[0-9]{1,19}\\z"), "birth");
        expires = Number(start[4]);
        Require(expires > Utc() && expires <= Utc() + 120000, "expiry");
        string operation = start[5], purpose = start[6], path = start[8];
        Require(operation == "check" || operation == "ensure" || operation == "create" || operation == "open" || operation == "read", "operation");
        Require(purpose == "directory" || purpose == "managed" || purpose == "attachment", "purpose");
        Require(operation != "ensure" || purpose == "directory", "purpose");
        Require(operation != "create" || purpose == "managed", "purpose");
        Require(operation != "open" || purpose == "attachment", "purpose");
        Require(operation != "read" || purpose == "managed", "purpose");
        long maximum = Number(start[7]);
        Require(maximum <= 9007199254740991L, "maximum");
        using (var caller = new Owner(ownerPid, start[3])) {
          owner = caller.Handle;
          token = Guid.NewGuid().ToString("N");
          Alive();
          using (var chain = new Chain(path)) {
            Alive();
            if (operation == "ensure") chain.Ensure();
            Evidence before = null;
            if (operation == "read" || operation == "open") using (var metadata = chain.Open(false, false, false)) {
              before = Native.Inspect(metadata, purpose, chain.Target); Require(before.Size <= maximum, "size-limit");
            }
            using (var held = chain.Open(operation == "create", operation == "open" || operation == "read", purpose == "directory")) {
              var initial = Native.Inspect(held, purpose, chain.Target);
              Require(before == null || (before.Identity == initial.Identity && before.Size == initial.Size && before.Security == initial.Security && before.Change == initial.Change && before.Write == initial.Write), "changed-before-open");
              Require(initial.Size <= maximum, "size-limit");
              chain.Validate();
              if (operation == "create") Require(initial.Size == 0 && initial.Protected, "creation");
              Send(0, "ready", initial.Identity + "\n" + initial.Size.ToString(CultureInfo.InvariantCulture));
              if (operation == "check" || operation == "ensure") return 0;
              using (var stream = new FileStream(held, operation == "create" ? FileAccess.ReadWrite : FileAccess.Read, 1, false)) {
                Session(stream, chain, initial, purpose, operation == "create", maximum);
              }
            }
          }
        }
        return 0;
      } catch (Exception error) {
        // Never echo paths, payloads or framework exception text into the control pipe.
        try { Reply("1\nfailed\n" + (error is Win32Exception ? "io\n" + ((Win32Exception)error).NativeErrorCode : "refused\n" + (error is Refusal ? ((Refusal)error).Code : "malformed"))); } catch { }
        return 31;
      } finally {
        Finished.Set();
        if (watchdog != null && !watchdog.Join(1000)) Environment.Exit(44);
      }
    }

    static void Session(FileStream stream, Chain chain, Evidence initial, string purpose, bool writer, long maximum) {
      long id = 0, readThrough = 0;
      for (;;) {
        progress = Clock.ElapsedMilliseconds;
        var request = Control().Split('\n');
        Require(request.Length >= 5 && request[0] == "1" && request[1] == nonce && request[3] == token, "command");
        Require(Number(request[2]) == ++id, "sequence");
        string operation = request[4];
        if (operation == "close" && request.Length == 5) return;
        if (operation == "bound" && request.Length == 6) {
          bool same = Published(stream.SafeFileHandle, chain, initial, purpose, request[5]);
          Send(id, "bound", (same ? "true" : "false") + "\n" + stream.Length.ToString(CultureInfo.InvariantCulture));
        } else if (!writer && purpose == "managed" && operation == "complete" && request.Length == 5) {
          Require(readThrough == initial.Size, "incomplete");
          Require(Bound(stream.SafeFileHandle, chain, initial, purpose, true), "binding");
          Send(id, "complete", "");
          return;
        } else if (writer && operation == "write" && request.Length == 6) {
          int count = Count(request[5]);
          var bytes = Frame(2, ChunkLimit);
          Require(count == bytes.Length && stream.Position <= maximum - count, "write-limit");
          Require(Bound(stream.SafeFileHandle, chain, initial, purpose, false), "binding");
          Alive();
          stream.Write(bytes, 0, bytes.Length);
          Alive();
          Require(Bound(stream.SafeFileHandle, chain, initial, purpose, false), "binding");
          Send(id, "write", count.ToString(CultureInfo.InvariantCulture));
        } else if (writer && operation == "sync" && request.Length == 5) {
          Alive(); stream.Flush(true); Alive();
          Require(Bound(stream.SafeFileHandle, chain, initial, purpose, false), "binding");
          Send(id, "sync", "");
        } else if (!writer && operation == "read" && request.Length == 7) {
          long offset = Number(request[5]); int count = Count(request[6]);
          long limit = initial.Size + (purpose == "attachment" ? 1 : 0);
          Require(offset <= limit && count <= limit - offset, "read-limit");
          Require(Bound(stream.SafeFileHandle, chain, initial, purpose, true), "binding");
          if (purpose == "managed") Require(offset == readThrough, "read-order");
          var bytes = new byte[count];
          Alive(); stream.Position = offset;
          int received = 0;
          while (received < count) {
            Alive(); int n = stream.Read(bytes, received, count - received); Alive();
            if (n == 0) { Require(purpose == "attachment", "early-eof"); break; } received += n;
          }
          Require(Bound(stream.SafeFileHandle, chain, initial, purpose, true), "binding");
          if (received != count) Array.Resize(ref bytes, received);
          Send(id, "read", received.ToString(CultureInfo.InvariantCulture));
          Emit(2, bytes);
          if (purpose == "managed") readThrough += count;
        } else throw new InvalidDataException("command");
      }
    }

    static bool Published(SafeFileHandle held, Chain original, Evidence initial, string purpose, string path) {
      Alive();
      try {
        original.Validate();
        using (var published = new Chain(path)) {
          var current = Native.Inspect(held, purpose, null);
          using (var named = published.Open(false, false, purpose == "directory")) {
            var at = Native.Inspect(named, purpose, published.Target);
            original.Validate(); published.Validate();
            return current.Identity == initial.Identity && at.Identity == current.Identity && at.Security == current.Security;
          }
        }
      } catch (Refusal refusal) {
        if (refusal.Code == "expired" || refusal.Code == "owner-dead") throw;
        return false;
      } catch (Win32Exception error) {
        if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return false;
        throw;
      }
    }

    static bool Bound(SafeFileHandle held, Chain chain, Evidence initial, string purpose, bool unchanged) {
      try {
      Alive(); chain.Validate();
      var current = Native.Inspect(held, purpose, chain.Target);
      using (var named = chain.Open(false, false, purpose == "directory")) {
        var at = Native.Inspect(named, purpose, chain.Target);
        return current.Identity == initial.Identity && at.Identity == current.Identity && at.Security == current.Security &&
          (!unchanged || (current.Size == initial.Size && current.Change == initial.Change && current.Write == initial.Write && current.Security == initial.Security &&
            at.Size == initial.Size && at.Change == initial.Change && at.Write == initial.Write));
      }
      } catch (Refusal refusal) { if (refusal.Code == "final-path") return false; throw; }
    }

    static void Watch() {
      while (!Finished.WaitOne(20)) {
        long expiry = Interlocked.Read(ref expires);
        if (expiry != 0 && Utc() >= expiry) Environment.Exit(42);
        if (Clock.ElapsedMilliseconds >= 120000 || Clock.ElapsedMilliseconds - Interlocked.Read(ref progress) >= 30000) Environment.Exit(42);
        IntPtr original = owner;
        if (original != IntPtr.Zero && Native.WaitForSingleObject(original, 0) != 258) Environment.Exit(41);
      }
    }

    internal static void Alive() {
      long expiry = Interlocked.Read(ref expires);
      Require(!Finished.WaitOne(0) && Clock.ElapsedMilliseconds < 120000 && (expiry == 0 || Utc() < expiry), "expired");
      Require(owner == IntPtr.Zero || Native.WaitForSingleObject(owner, 0) == 258, "owner-dead");
    }
    static long Utc() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000; }
    internal static void Require(bool condition, string reason) { if (!condition) throw new Refusal(reason); }
    static long Number(string value) {
      long number;
      Require(Regex.IsMatch(value, "\\A(?:0|[1-9][0-9]{0,15})\\z") && long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number), "number");
      return long.Parse(value, CultureInfo.InvariantCulture);
    }
    static int PositiveInt(string value) { long n = Number(value); Require(n > 0 && n <= int.MaxValue, "pid"); return (int)n; }
    static int Count(string value) { long n = Number(value); Require(n <= ChunkLimit, "chunk-limit"); return (int)n; }
    static void Pump() {
      try {
        for (;;) {
          var header = Exact(5);
          FrameSpace.WaitOne();
          uint length = BitConverter.ToUInt32(header, 0);
          byte kind = header[4];
          Require((kind == 1 || kind == 2) && length >= 1 && length <= (kind == 1 ? ControlLimit : ChunkLimit) + 1, "frame");
          var body = new byte[length]; body[0] = kind;
          ReadInto(body, 1, body.Length - 1);
          lock (Frames) Frames.Enqueue(body);
          FrameReady.Set();
        }
      } catch { Environment.Exit(40); }
    }
    static string Control() { return Utf8.GetString(Frame(1, ControlLimit)); }
    static byte[] Frame(byte kind, int limit) {
      FrameReady.WaitOne();
      byte[] frame;
      lock (Frames) frame = Frames.Dequeue();
      FrameSpace.Release();
      Require(frame[0] == kind && frame.Length - 1 <= limit, "frame");
      var bytes = new byte[frame.Length - 1]; Buffer.BlockCopy(frame, 1, bytes, 0, bytes.Length); return bytes;
    }
    static byte[] Exact(int count) {
      var bytes = new byte[count]; ReadInto(bytes, 0, count); return bytes;
    }
    static void ReadInto(byte[] bytes, int at, int count) {
      int end = at + count;
      while (at < end) { Alive(); int n = Input.Read(bytes, at, end - at); Require(n != 0, "eof"); at += n; }
    }
    static void Send(long id, string kind, string body) { Reply("1\n" + nonce + "\n" + id + "\n" + token + "\n" + kind + "\n" + body); }
    static void Reply(string body) { Emit(1, Utf8.GetBytes(body)); }
    static void Emit(byte kind, byte[] bytes) {
      Alive(); Require(bytes.Length <= (kind == 1 ? ControlLimit : ChunkLimit), "output-limit");
      var header = BitConverter.GetBytes(bytes.Length + 1);
      Output.Write(header, 0, 4); Output.WriteByte(kind); Output.Write(bytes, 0, bytes.Length); Output.Flush(); Alive();
    }
  }

  internal sealed class Refusal : Exception {
    internal readonly string Code;
    internal Refusal(string code) { Code = code; }
  }

  internal sealed class Owner : IDisposable {
    internal readonly IntPtr Handle;
    internal readonly string Birth;
    internal Owner(int pid, string expected) {
      Handle = Native.OpenProcess(0x101000, false, pid);
      if (Handle == IntPtr.Zero) throw Native.Error();
      try {
        long birth, exit, kernel, user;
        if (!Native.GetProcessTimes(Handle, out birth, out exit, out kernel, out user)) throw Native.Error();
        Birth = birth.ToString(CultureInfo.InvariantCulture);
        Program.Require(expected == null || expected == Birth, "owner-birth");
        Program.Require(Native.WaitForSingleObject(Handle, 0) == 258, "owner-dead");
        IntPtr token;
        if (!Native.OpenProcessToken(Handle, 8, out token)) throw Native.Error();
        try { using (var identity = new WindowsIdentity(token)) Program.Require(identity.User.Value == Native.Sid(), "owner-sid"); }
        finally { Native.CloseHandle(token); }
      } catch { Native.CloseHandle(Handle); throw; }
    }
    public void Dispose() {
      // Watch holds this original handle until process exit; closing during its wait is invalid.
    }
  }

  internal sealed class Evidence {
    internal string Identity, Security, Change, Write;
    internal long Size;
    internal bool Protected;
  }

  internal sealed class Chain : IDisposable {
    internal readonly string Target;
    readonly string drive, volume;
    readonly List<SafeFileHandle> ancestors = new List<SafeFileHandle>();
    readonly List<string> names = new List<string>(), identities = new List<string>();
    internal Chain(string path) {
      path = Spelling(path);
      string root = path.Substring(0, 3);
      Program.Require(Native.GetDriveTypeW(root) == 3, "fixed-volume");
      var guid = new StringBuilder(64);
      if (!Native.GetVolumeNameForVolumeMountPointW(root, guid, (uint)guid.Capacity)) throw Native.Error();
      Program.Require(Regex.IsMatch(guid.ToString(), "\\A\\\\\\\\\\?\\\\Volume\\{[0-9a-fA-F-]{36}\\}\\\\\\z"), "volume-guid");
      var parts = path.Substring(3).Split('\\');
      drive = root; volume = guid.ToString();
      Target = guid.ToString() + string.Join("\\", parts);
      try {
        string at = guid.ToString();
        for (int i = 0; i < parts.Length; i++) {
          Program.Alive();
          var h = i == 0 ? Native.Open(at, 0x20080, 3, 3, IntPtr.Zero, true) : Native.Relative(ancestors[i - 1], parts[i - 1], 0x120080, 3, 1, true, false);
          ancestors.Add(h); names.Add(at);
          Native.Kind(h, true, at);
          identities.Add(Native.Identity(h));
          if (i == 0) {
            uint serial, maxComponent, flags; var fs = new StringBuilder(32);
            if (!Native.GetVolumeInformationByHandleW(h, null, 0, out serial, out maxComponent, out flags, fs, 32)) throw Native.Error();
            Program.Require(fs.ToString() == "NTFS" && (flags & 8) != 0 && maxComponent != 0, "filesystem");
            foreach (string part in parts) Program.Require(part.Length <= maxComponent, "component-limit");
          }
          at += parts[i] + (i == parts.Length - 1 ? "" : "\\");
        }
        Validate();
      } catch { Dispose(); throw; }
    }
    static string Spelling(string path) {
      Program.Require(path.Length >= 4 && path.Length <= 32000 && Regex.IsMatch(path, "\\A[A-Za-z]:[\\\\/]"), "absolute-drive-path");
      path = path.Replace('/', '\\');
      var parts = path.Substring(3).Split('\\');
      Program.Require(parts.Length <= 256, "depth");
      foreach (string part in parts) {
        Program.Require(part.Length > 0 && part != "." && part != ".." && !part.EndsWith(".") && !part.EndsWith(" "), "component");
        foreach (char c in part) Program.Require(!char.IsControl(c) && ":*?\"<>|".IndexOf(c) < 0, "namespace");
        string stem = part.Split('.')[0].TrimEnd(' ');
        Program.Require(!Regex.IsMatch(stem, "\\A(?:CON|PRN|AUX|NUL|CONIN\\$|CONOUT\\$|CLOCK\\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant), "device");
      }
      return path;
    }
    internal SafeFileHandle Open(bool create, bool data, bool directory) {
      Program.Alive(); Validate();
      return Native.Relative(ancestors[ancestors.Count - 1], Target.Substring(Target.LastIndexOf('\\') + 1), create ? 0xc0120000 : data ? 0x80120000 : 0x120080, 7, create ? 2U : 1U, directory, create);
    }
    internal void Ensure() {
      Program.Alive(); Validate();
      try { using (var created = Native.Relative(ancestors[ancestors.Count - 1], Target.Substring(Target.LastIndexOf('\\') + 1), 0x120080, 7, 2, true, true)) {
        var evidence = Native.Inspect(created, "directory", Target); Program.Require(evidence.Protected, "creation");
      }} catch (Win32Exception error) { if (error.NativeErrorCode != 183) throw; }
      Validate();
    }
    internal void Validate() {
      Program.Alive();
      var currentVolume = new StringBuilder(64);
      if (!Native.GetVolumeNameForVolumeMountPointW(drive, currentVolume, (uint)currentVolume.Capacity)) throw Native.Error();
      Program.Require(string.Equals(volume, currentVolume.ToString(), StringComparison.Ordinal), "drive-binding");
      for (int i = 0; i < ancestors.Count; i++) {
        Native.Kind(ancestors[i], true, names[i]);
        Program.Require(Native.Identity(ancestors[i]) == identities[i], "ancestor-identity");
        using (var named = i == 0 ? Native.Open(names[i], 0x20080, 3, 3, IntPtr.Zero, true) : Native.Relative(ancestors[i - 1], names[i].TrimEnd('\\').Substring(names[i].TrimEnd('\\').LastIndexOf('\\') + 1), 0x120080, 3, 1, true, false)) {
          Native.Kind(named, true, names[i]);
          Program.Require(Native.Identity(named) == identities[i], "ancestor-binding");
        }
      }
    }
    public void Dispose() { for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Dispose(); ancestors.Clear(); }
  }

  internal static class Native {
    [StructLayout(LayoutKind.Sequential)] struct UnicodeName { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { internal int Length; internal IntPtr Root, Name; internal uint Flags; internal IntPtr Security, Quality; }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { internal IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)] internal struct FileInformation {
      internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
      internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, [Out] byte[] information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool GetVolumeNameForVolumeMountPointW(string path, StringBuilder name, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern uint GetDriveTypeW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder name, uint size, out uint serial, out uint maxComponent, out uint flags, StringBuilder filesystem, uint filesystemSize);
    [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint requested, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status, IntPtr size, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo([Out] byte[] information);
    internal static bool Target() {
      var system = new byte[48]; GetNativeSystemInfo(system);
      if (!Environment.Is64BitProcess || BitConverter.ToUInt16(system, 0) != 9 || Environment.OSVersion.Version.Major < 10) return false;
      using (var framework = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full")) {
        object release = framework == null ? null : framework.GetValue("Release");
        return release is int && (int)release >= 533320;
      }
    }
    internal static Win32Exception Error() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    internal static string Sid() { using (var id = WindowsIdentity.GetCurrent()) return id.User.Value; }
    internal static SafeFileHandle Open(string path, uint access, uint share, uint disposition, IntPtr security, bool directory) {
      Program.Alive();
      var handle = CreateFileW(path, access, share, security, disposition, 0x200000U | (directory ? 0x2000000U : 0), IntPtr.Zero);
      if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
      return handle;
    }
    static byte[] Descriptor(bool directory) {
      string sid = Sid(); var sd = new RawSecurityDescriptor("O:" + sid + "D:P(A;" + (directory ? "OICI" : "") + ";FA;;;" + sid + ")");
      var bytes = new byte[sd.BinaryLength]; sd.GetBinaryForm(bytes, 0); return bytes;
    }
    internal static SafeFileHandle Relative(SafeFileHandle parent, string name, uint access, uint share, uint disposition, bool directory, bool createPrivate) {
      Program.Alive();
      Program.Require(name.Length > 0 && name.Length <= 255 && name.IndexOfAny(new char[] {'\\', '/', ':', '\0'}) < 0 && name != "." && name != "..", "relative-name");
      IntPtr text = Marshal.StringToHGlobalUni(name), pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
      GCHandle pinned = default(GCHandle);
      bool retained = false;
      try {
        var unicode = new UnicodeName { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)(name.Length * 2), Buffer = text };
        Marshal.StructureToPtr(unicode, pointer, false);
        if (createPrivate) pinned = GCHandle.Alloc(Descriptor(directory), GCHandleType.Pinned);
        parent.DangerousAddRef(ref retained);
        var attributes = new ObjectAttributes {
          Length = Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.DangerousGetHandle(), Name = pointer,
          Flags = 0x1000, Security = createPrivate ? pinned.AddrOfPinnedObject() : IntPtr.Zero
        };
        IoStatus io; SafeFileHandle handle;
        // Winternl's documented relative open rejects reparses during name parsing.
        int result = NtCreateFile(out handle, access, ref attributes, out io, IntPtr.Zero, 0x80, share, disposition, 0x200020U | (directory ? 1U : 0x40U), IntPtr.Zero, 0);
        if (result < 0) { if (handle != null) handle.Dispose(); throw new Win32Exception((int)RtlNtStatusToDosError(result)); }
        Program.Require(handle != null && !handle.IsInvalid, "native-handle");
        return handle;
      } finally {
        if (retained) parent.DangerousRelease();
        if (pinned.IsAllocated) pinned.Free();
        Marshal.FreeHGlobal(pointer); Marshal.FreeHGlobal(text);
      }
    }
    internal static string Identity(SafeFileHandle handle) {
      var id = Query(handle, 18, 24);
      return "win32-file-id-v1:" + BitConverter.ToUInt64(id, 0).ToString("x16", CultureInfo.InvariantCulture) + ":" + BitConverter.ToString(id, 8, 16).Replace("-", "").ToLowerInvariant();
    }
    static byte[] Query(SafeFileHandle handle, int kind, int size) {
      var bytes = new byte[size];
      if (!GetFileInformationByHandleEx(handle, kind, bytes, (uint)size)) throw Error();
      return bytes;
    }
    internal static void Kind(SafeFileHandle handle, bool directory, string expected) {
      var tag = Query(handle, 9, 8); uint attributes = BitConverter.ToUInt32(tag, 0);
      Program.Require(GetFileType(handle) == 1 && (attributes & 0x400) == 0 && BitConverter.ToUInt32(tag, 4) == 0 && ((attributes & 16) != 0) == directory, "kind");
      var final = new StringBuilder(32768); uint n = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 1);
      if (n == 0) throw Error();
      Program.Require(n < final.Capacity && (expected == null || string.Equals(final.ToString().TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.Ordinal)), "final-path");
    }
    internal static Evidence Inspect(SafeFileHandle handle, string purpose, string expected) {
      Kind(handle, purpose == "directory", expected);
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) throw Error();
      ulong size = ((ulong)information.SizeHigh << 32) | information.SizeLow;
      Program.Require(size <= 9007199254740991UL && (purpose != "managed" || information.Links == 1), "metadata");
      IntPtr owner, group, dacl, sacl, descriptor;
      uint result = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
      if (result != 0) throw new Win32Exception((int)result);
      try {
        uint length = GetSecurityDescriptorLength(descriptor);
        Program.Require(length > 0 && length <= 65536, "descriptor-size");
        var bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
        var sd = new RawSecurityDescriptor(bytes, 0);
        Program.Require(sd.Owner != null && sd.Owner.Value == Sid(), "owner");
        if (purpose != "attachment") PrivateAcl(sd);
        var basic = Query(handle, 0, 40);
        return new Evidence {
          Identity = Identity(handle), Size = (long)size, Security = Convert.ToBase64String(bytes),
          Change = BitConverter.ToInt64(basic, 24).ToString(CultureInfo.InvariantCulture),
          Write = BitConverter.ToInt64(basic, 16).ToString(CultureInfo.InvariantCulture),
          Protected = (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0
        };
      } finally { LocalFree(descriptor); }
    }
    static void PrivateAcl(RawSecurityDescriptor descriptor) {
      var acl = descriptor.DiscretionaryAcl;
      Program.Require((descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0 && acl != null && acl.Count > 0, "dacl");
      bool ownerAllow = false;
      foreach (GenericAce raw in acl) {
        var ace = raw as CommonAce;
        Program.Require(ace != null && !ace.IsCallback && (ace.AceQualifier == AceQualifier.AccessAllowed || ace.AceQualifier == AceQualifier.AccessDenied), "ace-kind");
        Program.Require((((int)ace.AceFlags) & ~31) == 0, "ace-flags");
        Program.Require(ace.AceQualifier != AceQualifier.AccessDenied, "deny-ace");
        string sid = ace.SecurityIdentifier.Value;
        if (ace.AceQualifier == AceQualifier.AccessAllowed && ace.AccessMask != 0) {
          Program.Require(sid == Sid() || sid == "S-1-5-18" || sid == "S-1-5-32-544", "trustee");
          if (sid == Sid() && (ace.AceFlags & AceFlags.InheritOnly) == 0 && (ace.AccessMask & 0x1f01ff) == 0x1f01ff) ownerAllow = true;
        }
      }
      Program.Require(ownerAllow, "usable-dacl");
    }
  }
}
