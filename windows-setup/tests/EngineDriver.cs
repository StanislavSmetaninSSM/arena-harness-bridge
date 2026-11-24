using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;

namespace ArenaHarnessSetup
{
    /// <summary>
    /// Invokes the production setup assembly or records calls as an isolated Desktop stand-in.
    /// </summary>
    internal static class EngineDriver
    {
        /// <summary>
        /// Dispatches a discovery or installation request, or records the native child invocation.
        /// </summary>
        /// <param name="args">
        /// The requested setup operation and inputs, or the Electron arguments supplied by setup.
        /// </param>
        /// <returns>
        /// Zero on success and a nonzero code when setup or the simulated native CLI fails.
        /// </returns>
        private static int Main(string[] args)
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            if (args[0] == "hold")
            {
                Console.WriteLine("ready");
                Console.ReadLine();
                return 0;
            }
            if (args[0] == "--expose-internals")
            {
                string home = Environment.GetEnvironmentVariable("DSH_HOME");
                Directory.CreateDirectory(home);
                File.WriteAllLines(Path.Combine(home, "child.txt"), args.Concat(new[] {
                    Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")
                }).ToArray());
                string gate = Path.Combine(home, "pause");
                for (int i = 0; i < 400 && File.Exists(gate); i++) Thread.Sleep(25);
                if (File.Exists(Path.Combine(home, "reject")))
                {
                    Console.Error.WriteLine("incompatible plugin version");
                    return 3;
                }
                return 0;
            }
            try
            {
                Thread.CurrentThread.CurrentUICulture = new CultureInfo("en-US");
                if (args[0] == "home")
                    Console.WriteLine(SetupEngine.FindHome(args[1]));
                else if (args[0] == "desktop")
                    Console.WriteLine(SetupEngine.FindDesktop());
                else
                    SetupEngine.Install(args[1], args[2], Console.WriteLine);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
        }
    }
}
