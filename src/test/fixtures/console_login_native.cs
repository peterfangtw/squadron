using System;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Threading;

class ConsoleLoginFixture {
  delegate bool Handler(uint kind);
  static Handler handler;
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler value, bool add);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup { public int size; public string reserved, desktop, title; public uint x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool CreateProcess(string image, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll")] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  static void Main(string[] args) {
    if (args[0] == "resources") {
      Console.Write("[");
      for (int i = 1; i < args.Length; i++) using (var process = Process.GetProcessById(int.Parse(args[i]))) {
        if (i > 1) Console.Write(",");
        Console.Write("{\"pid\":" + process.Id + ",\"birth\":\"" + process.StartTime.ToUniversalTime().ToFileTimeUtc() + "\",\"cpuMs\":" + process.TotalProcessorTime.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture) +
          ",\"workingSetBytes\":" + process.WorkingSet64 + ",\"handles\":" + process.HandleCount + ",\"threads\":" + process.Threads.Count + "}");
      }
      Console.Write("]"); return;
    }
    if (args[0] == "observe" || args[0] == "wait-member") {
      IntPtr handle = OpenProcess(0x1000 | 0x100000, false, int.Parse(args[1]));
      if (handle == IntPtr.Zero) { if (Marshal.GetLastWin32Error() != 87) Environment.Exit(41); Console.Write("gone"); return; }
      try {
        long b,e,k,u;
        if (!GetProcessTimes(handle, out b, out e, out k, out u)) Environment.Exit(41);
        if (b.ToString() != args[2]) { Console.Write("replaced"); return; }
        Console.Write(WaitForSingleObject(handle, args[0] == "wait-member" ? 5000U : 0U) == 0 ? "exited" : "alive");
      } finally { CloseHandle(handle); }
      return;
    }
    if (args[0] == "normal") { Console.Write("native"); return; }
    handler = delegate(uint kind) { return true; };
    SetConsoleCtrlHandler(handler, true);
    TcpListener listener = null;
    if (args[0] == "grandchild" || args[0] == "quiet-grandchild") {
      listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
      var self = Process.GetCurrentProcess();
      var root = Process.GetProcessById(int.Parse(args[0] == "quiet-grandchild" ? args[5] : args[2]));
      string receipt = "{\"pid\":" + self.Id + ",\"birth\":\"" + self.StartTime.ToUniversalTime().ToFileTimeUtc() + "\",\"root\":{\"pid\":" + root.Id + ",\"birth\":\"" + root.StartTime.ToUniversalTime().ToFileTimeUtc() + "\"},\"port\":" + ((IPEndPoint)listener.LocalEndpoint).Port + "}";
      GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
      if (args[0] == "quiet-grandchild") {
        var output = new IntPtr(long.Parse(args[3])); var error = new IntPtr(long.Parse(args[4]));
        uint outputType = GetFileType(output), errorType = GetFileType(error);
        bool outputClosed = CloseHandle(output), errorClosed = CloseHandle(error);
        FreeConsole();
        File.WriteAllText(args[2], receipt.TrimEnd('}') + ",\"outputType\":" + outputType + ",\"errorType\":" + errorType + ",\"outputClosed\":" + outputClosed.ToString().ToLowerInvariant() + ",\"errorClosed\":" + errorClosed.ToString().ToLowerInvariant() + "}");
      } else { Console.WriteLine(receipt); Console.Out.Flush(); }
      using (var ready = EventWaitHandle.OpenExisting(args[1])) ready.Set();
    } else {
      string name = "Local\\squadron-fixture-" + Guid.NewGuid().ToString("N");
      using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, name)) {
        bool quiet = args[0] == "exit-tree";
        string receipt = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".json");
        if (quiet) {
          string image = Process.GetCurrentProcess().MainModule.FileName;
          LaunchQuiet(image, name, receipt);
        } else Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
          "grandchild " + name + " " + Process.GetCurrentProcess().Id) { UseShellExecute = false });
        if (!ready.WaitOne(5000)) Environment.Exit(42);
        if (quiet) { Console.WriteLine(File.ReadAllText(receipt)); Console.Out.Flush(); File.Delete(receipt); }
      }
      if (args[0] == "drain" || args[0] == "exit-tree") return;
    }
    new ManualResetEvent(false).WaitOne();
    // Forced GC closed this socket while the process was alive (native control, 2026-11-05).
    GC.KeepAlive(listener);
  }

  static void LaunchQuiet(string image, string name, string receipt) {
    IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr attributes = Marshal.AllocHGlobal(size), handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
    try {
      if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) Environment.Exit(43);
      IntPtr output = GetStdHandle(-11), error = GetStdHandle(-12);
      Marshal.WriteIntPtr(handles, output); Marshal.WriteIntPtr(handles, IntPtr.Size, error);
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero)) Environment.Exit(43);
      var startup = new StartupEx { startup = new Startup { size = Marshal.SizeOf(typeof(StartupEx)) }, attributes = attributes };
      ProcessInfo child;
      // Inherit pipes as ordinary handles: CLR standard-stream duplicates would keep them open.
      if (!CreateProcess(image, new StringBuilder("\"" + image + "\" quiet-grandchild " + name + " \"" + receipt + "\" " + output.ToInt64() + " " + error.ToInt64() + " " + Process.GetCurrentProcess().Id),
        IntPtr.Zero, IntPtr.Zero, true, 0x08000000 | 0x80000, IntPtr.Zero, null, ref startup, out child)) Environment.Exit(43);
      CloseHandle(child.process); CloseHandle(child.thread);
    } finally { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(handles); }
  }
}
