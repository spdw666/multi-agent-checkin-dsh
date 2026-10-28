using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace GatewayWebViewHost {
    internal sealed class Options {
        internal string Config, Node, SelfTest, Capture, ContractTest, ToolsContractTest, InstanceEvidence, InstancePage;
        internal bool Demo, Background, QuitUi, Maximized;
        internal bool Portable;
        internal string UserDataRoot, UiVersion;
        internal int? Left, Top;
        internal int Width = 1360, Height = 900;
        internal double Scale = 1;
        internal static Options Parse(string[] args) {
            var o = new Options();
            for (int i = 0; i < args.Length; i++) {
                string a = args[i];
                if (a == "--demo") { o.Demo = true; continue; }
                if (a == "--background") { o.Background = true; continue; }
                if (a == "--quit-ui") { o.QuitUi = true; continue; }
                if (a == "--maximized") { o.Maximized = true; continue; }
                if (i + 1 >= args.Length) throw new ArgumentException("启动参数缺少值。");
                string v = args[++i];
                if (a == "--config") o.Config = Path.GetFullPath(v);
                else if (a == "--node") o.Node = Path.GetFullPath(v);
                else if (a == "--self-test") o.SelfTest = Path.GetFullPath(v);
                else if (a == "--capture") o.Capture = Path.GetFullPath(v);
                else if (a == "--contract-test") o.ContractTest = Path.GetFullPath(v);
                else if (a == "--tools-contract-test") o.ToolsContractTest = Path.GetFullPath(v);
                else if (a == "--instance-evidence" || a == "--capture-running") o.InstanceEvidence = Path.GetFullPath(v);
                else if (a == "--instance-page") o.InstancePage = BridgePolicy.NormalizePage(v);
                else if (a == "--left") o.Left = int.Parse(v);
                else if (a == "--top") o.Top = int.Parse(v);
                else if (a == "--width") o.Width = int.Parse(v);
                else if (a == "--height") o.Height = int.Parse(v);
                else if (a == "--scale") o.Scale = double.Parse(v, System.Globalization.CultureInfo.InvariantCulture);
                else throw new ArgumentException("启动参数未识别。");
            }
            if (o.Width < 480 || o.Width > 4096 || o.Height < 400 || o.Height > 3072 || o.Scale < 0.5 || o.Scale > 3) throw new ArgumentException("窗口尺寸或缩放参数超出可用区间。");
            o.ResolveDefaults(); return o;
        }
        private void ResolveDefaults() {
            string root=AppDomain.CurrentDomain.BaseDirectory;
            string marker=Path.Combine(root,"gateway.portable.json");
            if(File.Exists(marker)) {
                var metadata=Json.Object(File.ReadAllText(marker,Encoding.UTF8));
                if(Json.Text(metadata,"mode")!="portable"||Convert.ToInt32(metadata["schemaVersion"])!=1)throw new ArgumentException("便携包标识无效。");
                Portable=true;UiVersion=Json.Text(metadata,"uiVersion");if(UiVersion.Length>60||!UiVersion.All(c=>Char.IsLetterOrDigit(c)||c=='.'||c=='-'))throw new ArgumentException("界面版本标识无效。");
                string id=Program.Identity(Path.GetFullPath(root));
                UserDataRoot=WritableDirectory(Path.Combine(root,"user-data"))??WritableDirectory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AiCreditGatewayWebPortable",id));
                if(UserDataRoot==null)throw new IOException("请选择可写目录解压运行。");
                if(String.IsNullOrEmpty(Config))Config=Path.Combine(UserDataRoot,"config.local.json");
                if(String.IsNullOrEmpty(Node))Node=Path.Combine(root,"runtime","node.exe");
                Config=Path.GetFullPath(Config);Node=Path.GetFullPath(Node);return;
            }
            string installed=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"AI积分网关","桌面版");
            if(String.IsNullOrEmpty(Config)) {
                foreach(string dir in new[]{root,installed}) {
                    string local=Path.Combine(dir,"desktop.local.json");
                    if(File.Exists(local)){string reference=Json.Text(Json.Object(File.ReadAllText(local,Encoding.UTF8)),"configFile");if(!String.IsNullOrWhiteSpace(reference)){Config=Path.GetFullPath(Path.IsPathRooted(reference)?reference:Path.Combine(dir,reference));break;}}
                }
                if(String.IsNullOrEmpty(Config))Config=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AiCreditGateway","config.local.json");
            }
            if(String.IsNullOrEmpty(Node)) {
                var candidates=new List<string>{Path.Combine(root,"runtime","node.exe"),Path.Combine(installed,"runtime","node.exe")};
                candidates.AddRange((Environment.GetEnvironmentVariable("PATH")??"").Split(';').Where(p=>!String.IsNullOrWhiteSpace(p)).Select(p=>Path.Combine(p.Trim('"'),"node.exe")));
                Node=candidates.FirstOrDefault(File.Exists)??Path.Combine(root,"runtime","node.exe");
            }
            Config=Path.GetFullPath(Config);Node=Path.GetFullPath(Node);
        }
        private static string WritableDirectory(string path) {
            try{Directory.CreateDirectory(path);string probe=Path.Combine(path,".write-"+Guid.NewGuid().ToString("N"));using(File.Create(probe)){}File.Delete(probe);return path;}catch(IOException){return null;}catch(UnauthorizedAccessException){return null;}
        }
        internal void EnsurePortableConfiguration() {
            if(!Portable||File.Exists(Config))return;
            var config=Json.Object(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"core","config.first-run.json"),Encoding.UTF8));
            config["dataDir"]=Path.Combine(UserDataRoot,"data");
            // The shipped template has no accounts or routes. Port zero gives
            // this isolated instance its own OS-assigned loopback listener.
            Json.Save(Config,config);
        }
    }

    internal static class Json {
        internal static readonly JavaScriptSerializer Codec = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        internal static string Encode(object value) { return Codec.Serialize(value); }
        internal static Dictionary<string, object> Object(string value) { return Codec.Deserialize<Dictionary<string, object>>(value); }
        internal static string Text(IDictionary<string, object> o, string key) { return o != null && o.ContainsKey(key) && o[key] != null ? Convert.ToString(o[key]) : ""; }
        internal static void Save(string path, object value) { Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllText(path, Encode(value), new UTF8Encoding(false)); }
    }

    internal static class BridgePolicy {
        internal const string Home = "https://gateway-ui.local/index.html";
        internal static readonly string[] Methods = { "snapshot", "gateway.action", "gateway.lifecycle", "management.read", "management.action", "client.open", "client.shortcut", "window.minimize", "window.maximize", "window.close" };
        internal static readonly string[] ManagementSections = { "accounts", "routes", "records", "preferences", "diagnostics", "workbuddy", "updates", "operations" };
        private static readonly string[] ManagementActions = { "account.add","account.update","account.enable","account.delete","account.tasks","route.save","route.enable","route.delete","route.reorder","scheduler.save","server.save","relay.save","models.directory","models.test","models.import","models.export","diagnostics.doctor","diagnostics.health","diagnostics.rebind","diagnostics.routePreview","wb.settings","wb.profile","wb.inference","wb.refresh","wb.switch","wb.markStatus","wb.tasks","wb.tasksCancel","wb.rotation","wb.rotationEvaluate","wb.importPreview","wb.importCommit","wb.export","wb.capture","wb.loginStart","wb.loginPoll","wb.loginCancel","wb.merge","wb.pool","wb.poolSelect","updates.check","operations.settings","operations.keyCreate","operations.keyRevoke","operations.notificationRead","updates.settings","freeProvider.add","upstream.save","upstream.delete","diagnostics.restartDsh" };
        private static readonly Dictionary<string,string[]> ManagementViews = new Dictionary<string,string[]> {
            {"accounts",new[]{"list"}},{"routes",new[]{"config","directory","audit","relay","freeProviders"}},{"records",new[]{"claims","usage"}},{"preferences",new[]{"config"}},{"diagnostics",new[]{"context","requests","activation","audit"}},{"workbuddy",new[]{"summary","details","rotation","tasks","taskJob","pools"}},{"updates",new[]{"report"}},{"operations",new[]{"report","keys"}}
        };
        internal static readonly string[] Pages = { "overview", "accounts", "routes", "records", "manage-accounts", "manage-routes", "manage-records", "manage-preferences", "manage-diagnostics", "manage-workbuddy", "manage-updates", "manage-operations" };
        private static readonly string[] Actions = { "balances.refresh", "account.refresh", "account.claim", "claims.all" };
        private static readonly string[] LocalRoutes = new[]{""}.Concat(Pages.Select(p=>"#"+p)).ToArray();
        internal static string NormalizePage(string value) { if(Pages.Contains(value,StringComparer.Ordinal))return value;if(ManagementSections.Contains(value,StringComparer.Ordinal))return "manage-"+value;throw new ArgumentException("页面未识别。"); }
        internal static bool AllowedUri(string value) {
            Uri u;
            return Uri.TryCreate(value, UriKind.Absolute, out u) && u.Scheme == "https" && u.Host == "gateway-ui.local" && u.IsDefaultPort && u.AbsolutePath == "/index.html" && String.IsNullOrEmpty(u.UserInfo) && String.IsNullOrEmpty(u.Query) && LocalRoutes.Contains(u.Fragment, StringComparer.Ordinal);
        }
        internal static bool AllowedResource(string value) {
            Uri u;string[] files={"/index.html","/styles.css","/management.css","/app.js","/management.js","/demo.json","/assets/fonts/Montserrat-Regular.otf","/assets/fonts/Montserrat-Bold.otf","/assets/platform-icons/antigravity.png","/assets/platform-icons/bigmodel.png","/assets/platform-icons/cline.png","/assets/platform-icons/codearts.png","/assets/platform-icons/codebuddy.png","/assets/platform-icons/codebuddy-cn.png","/assets/platform-icons/freeapi.png","/assets/platform-icons/hailuo.png","/assets/platform-icons/jimeng.png","/assets/platform-icons/kling.png","/assets/platform-icons/liblib.png","/assets/platform-icons/lobster.png","/assets/platform-icons/loomy.png","/assets/platform-icons/minimax.png","/assets/platform-icons/nvidia.png","/assets/platform-icons/opencode.png","/assets/platform-icons/pixverse.png","/assets/platform-icons/qoder.png","/assets/platform-icons/qoder-cn.png","/assets/platform-icons/qwenwork.png","/assets/platform-icons/raccoon.png","/assets/platform-icons/trae.png","/assets/platform-icons/vidu.png","/assets/platform-icons/workbuddy.png","/assets/platform-icons/workbuddyai.png","/assets/platform-icons/xiaoyunque.png","/assets/platform-icons/zcode.png"};
            return Uri.TryCreate(value,UriKind.Absolute,out u)&&u.Scheme=="https"&&u.Host=="gateway-ui.local"&&u.IsDefaultPort&&String.IsNullOrEmpty(u.UserInfo)&&String.IsNullOrEmpty(u.Query)&&files.Contains(u.AbsolutePath,StringComparer.Ordinal);
        }
        internal static bool ValidId(string id) { return !String.IsNullOrEmpty(id) && id.Length <= 80 && id.All(c => Char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.'); }
        internal static bool KnownMethod(string method) { return Methods.Contains(method, StringComparer.Ordinal); }
        internal static bool ValidAction(IDictionary<string,object> args) {
            if(args==null||args.Keys.Any(k=>k!="action"&&k!="accountId"))return false;
            string action=Json.Text(args,"action");if(!Actions.Contains(action,StringComparer.Ordinal))return false;
            bool account=action.StartsWith("account.",StringComparison.Ordinal);string id=Json.Text(args,"accountId");
            return account?args.ContainsKey("accountId")&&args["accountId"] is string&&id.Length>0&&id.Length<=128&&id.All(c=>Char.IsLetterOrDigit(c)||c=='-'||c=='_'||c=='.'):!args.ContainsKey("accountId");
        }
        internal static bool ValidLifecycle(IDictionary<string,object> args) {
            return args!=null&&!args.Keys.Any(k=>k!="action"&&k!="confirmed")&&args.ContainsKey("action")&&args["action"] is string&&new[]{"server.start","server.stop"}.Contains(Json.Text(args,"action"),StringComparer.Ordinal)&&(!args.ContainsKey("confirmed")||args["confirmed"] is bool);
        }
        internal static bool ValidClientRequest(IDictionary<string,object> args) {
            return args!=null&&!args.Keys.Any(k=>k!="targetId"&&k!="confirmed")&&args.ContainsKey("targetId")&&args["targetId"] is string&&ValidId(Json.Text(args,"targetId"))&&(!args.ContainsKey("confirmed")||args["confirmed"] is bool);
        }
        internal static Dictionary<string,object> ClientTarget(Dictionary<string,object> report,string id) {
            object rows;report.TryGetValue("targets",out rows);var list=rows as System.Collections.IEnumerable;
            var matches=list==null?new Dictionary<string,object>[0]:list.Cast<object>().OfType<Dictionary<string,object>>().Where(row=>Json.Text(row,"id")==id).ToArray();
            if(matches.Length!=1)throw new ArgumentException("客户端目标未识别。");
            string exe=Json.Text(matches[0],"executable");
            if(!Path.IsPathRooted(exe)||exe.StartsWith("\\\\",StringComparison.Ordinal)||!String.Equals(Path.GetExtension(exe),".exe",StringComparison.OrdinalIgnoreCase))throw new ArgumentException("客户端启动程序未就绪。");
            return matches[0];
        }
        internal static bool ValidManagement(IDictionary<string,object> args,bool action) {
            string[] allowed=action?new[]{"section","view","accountId","limit","query","jobId","requestId","action","confirmed","values","items","accountIds","routeIds","content","token","revision"}:new[]{"section","view","accountId","limit","query","jobId","requestId"};
            if(args==null||args.Keys.Any(k=>!allowed.Contains(k,StringComparer.Ordinal)))return false;
            if(!action&&!args.ContainsKey("section"))return false;
            if(args.ContainsKey("section")&&(!(args["section"] is string)||!ManagementSections.Contains(Json.Text(args,"section"),StringComparer.Ordinal)))return false;
            if(args.ContainsKey("view")&&args.ContainsKey("section")&&!ManagementViews[Json.Text(args,"section")].Contains(Json.Text(args,"view"),StringComparer.Ordinal))return false;
            foreach(string key in new[]{"view","accountId","jobId","requestId"})if(args.ContainsKey(key)&&(!(args[key] is string)||Json.Text(args,key).Length>200||Json.Text(args,key).Any(Char.IsControl)))return false;
            if(args.ContainsKey("limit")){int limit;if(!Int32.TryParse(Json.Text(args,"limit"),out limit)||limit<1||limit>1000)return false;}
            if(args.ContainsKey("confirmed")&&!(args["confirmed"] is bool))return false;
            if(args.ContainsKey("revision")&&(!(args["revision"] is string)||Json.Text(args,"revision").Length!=64||!Json.Text(args,"revision").All(c=>c>='0'&&c<='9'||c>='a'&&c<='f')))return false;
            foreach(string key in new[]{"content","token"})if(args.ContainsKey(key)&&(!(args[key] is string)||Json.Text(args,key).Length>(key=="token"?32768:6*1024*1024)))return false;
            if(args.ContainsKey("values")&&!(args["values"] is Dictionary<string,object>))return false;
            foreach(string key in new[]{"items","accountIds","routeIds"})if(args.ContainsKey(key)) {var list=args[key] as System.Collections.IEnumerable;if(list==null||args[key] is string||args[key] is Dictionary<string,object>)return false;var entries=list.Cast<object>().ToArray();if(entries.Length>(key=="items"?5000:1000))return false;if(key!="items"&&entries.Any(v=>!(v is string)||Convert.ToString(v).Length>200||Convert.ToString(v).Any(Char.IsControl)))return false;}
            if(args.ContainsKey("query")&&(!(args["query"] is string)||Json.Text(args,"query").Length>200))return false;
            if(action&&!ManagementActions.Contains(Json.Text(args,"action"),StringComparer.Ordinal))return false;
            return true;
        }
        internal static bool AllowedExternalLogin(string value) {
            Uri url;string[] hosts={"codebuddy.cn","codebuddy.ai","workbuddy.cn","workbuddy.ai","tencent.com","qq.com"};
            return value!=null&&value.Length<=4096&&Uri.TryCreate(value,UriKind.Absolute,out url)&&url.Scheme=="https"&&url.IsDefaultPort&&String.IsNullOrEmpty(url.UserInfo)&&hosts.Any(host=>url.DnsSafeHost.Equals(host,StringComparison.OrdinalIgnoreCase)||url.DnsSafeHost.EndsWith("."+host,StringComparison.OrdinalIgnoreCase));
        }
        internal static object ManagementContract() {
            var pages=ManagementSections.Select(s=>new{section=s,page="manage-"+s,webOnly=true,allowed=AllowedUri(Home+"#manage-"+s)}).ToArray();
            return new{passed=pages.Count(p=>p.allowed),failed=pages.Count(p=>!p.allowed),pages=pages,nativeManagementEntry=false};
        }
        internal static string Quote(string text) {
            var b = new StringBuilder("\""); int slash = 0;
            foreach (char c in text) {
                if (c == '\\') { slash++; continue; }
                if (c == '"') { b.Append('\\', slash * 2 + 1); b.Append('"'); }
                else { b.Append('\\', slash); b.Append(c); }
                slash = 0;
            }
            b.Append('\\', slash * 2); return b.Append('"').ToString();
        }
        internal static object Contract() {
            var checks = new Dictionary<string, bool> {
                { "exactOrigin", AllowedUri(Home) },
                { "rejectHttp", !AllowedUri("http://gateway-ui.local/index.html") },
                { "rejectOtherHost", !AllowedUri("https://evil.local/index.html") },
                { "rejectSubdomain", !AllowedUri("https://gateway-ui.local.evil/index.html") },
                { "rejectNonDefaultPort", !AllowedUri("https://gateway-ui.local:8443/index.html") },
                { "rejectOtherPath", !AllowedUri("https://gateway-ui.local/settings.html") },
                { "rejectQuery", !AllowedUri(Home + "?target=claim") },
                { "rejectFragment", !AllowedUri(Home + "#unsafe") },
                { "knownLocalRoutes", AllowedUri(Home + "#overview") && AllowedUri(Home + "#accounts") && AllowedUri(Home + "#routes") && AllowedUri(Home + "#records") },
                { "rejectRouteWithQuery", !AllowedUri(Home + "?operation=claim#accounts") },
                { "rejectCredentials", !AllowedUri("https://u:p@gateway-ui.local/index.html") },
                { "rejectScriptUri", !AllowedUri("javascript:alert(1)") },
                { "knownSnapshot", KnownMethod("snapshot") },
                { "rejectGenericProxy", !KnownMethod("fetch") && !KnownMethod("claim") && !KnownMethod("exec") },
                { "validId", ValidId("request-10_test") },
                { "rejectLongId", !ValidId(new string('a', 81)) },
                { "rejectBadId", !ValidId("../secret") && !ValidId("") }
            };
            checks["knownBusinessMethods"]=KnownMethod("gateway.action")&&KnownMethod("management.read")&&KnownMethod("management.action");
            checks["boundedRefreshAction"]=ValidAction(new Dictionary<string,object>{{"action","balances.refresh"}})&&ValidAction(new Dictionary<string,object>{{"action","account.refresh"},{"accountId","SAMPLE"}});
            checks["boundedClaimAction"]=ValidAction(new Dictionary<string,object>{{"action","claims.all"}})&&ValidAction(new Dictionary<string,object>{{"action","account.claim"},{"accountId","SAMPLE"}});
            checks["rejectActionInjection"]=!ValidAction(new Dictionary<string,object>{{"action","exec"}})&&!ValidAction(new Dictionary<string,object>{{"action","balances.refresh"},{"url","https://example.invalid"}})&&!ValidAction(new Dictionary<string,object>{{"action","account.claim"},{"accountId","../secret"}});
            checks["knownWebManagementPages"]=ManagementSections.All(s=>AllowedUri(Home+"#manage-"+s)&&ValidManagement(new Dictionary<string,object>{{"section",s}},false));
            checks["rejectNativeToolMethod"]=!KnownMethod("tools.open");
            checks["rejectManagementInjection"]=!ValidManagement(new Dictionary<string,object>{{"section","accounts"},{"url","https://example.invalid"}},false)&&!ValidManagement(new Dictionary<string,object>{{"section","accounts"},{"method","exec"}},false);
            checks["boundedManagementAction"]=ValidManagement(new Dictionary<string,object>{{"section","preferences"},{"action","scheduler.save"},{"confirmed",true},{"revision",new string('a',64)},{"values",new Dictionary<string,object>()}},true)&&ValidManagement(new Dictionary<string,object>{{"action","operations.keyCreate"},{"confirmed",true}},true);
            checks["rejectManagementTypeDrift"]=!ValidManagement(new Dictionary<string,object>{{"section","preferences"},{"action","scheduler.save"},{"confirmed","yes"}},true)&&!ValidManagement(new Dictionary<string,object>{{"section","preferences"},{"action","scheduler.save"},{"revision","bad"}},true)&&!ValidManagement(new Dictionary<string,object>{{"action","exec"},{"confirmed",true}},true);
            checks["officialLoginOnly"]=AllowedExternalLogin("https://login.codebuddy.ai/login?state=SAMPLE")&&AllowedExternalLogin("https://cloud.tencent.com/login")&&!AllowedExternalLogin("https://codebuddy.ai.evil.invalid/login")&&!AllowedExternalLogin("http://workbuddy.ai/login")&&!AllowedExternalLogin("https://u:p@qq.com/login");
            checks["boundedLifecycle"]=KnownMethod("gateway.lifecycle")&&ValidLifecycle(new Dictionary<string,object>{{"action","server.start"},{"confirmed",true}})&&ValidLifecycle(new Dictionary<string,object>{{"action","server.stop"},{"confirmed",false}})&&!ValidLifecycle(new Dictionary<string,object>{{"action","server.stop"},{"url","https://example.invalid"}})&&!ValidLifecycle(new Dictionary<string,object>{{"action","exec"},{"confirmed",true}});
            checks["platformLogoResources"]=new[]{"https://gateway-ui.local/assets/platform-icons/antigravity.png","https://gateway-ui.local/assets/platform-icons/bigmodel.png","https://gateway-ui.local/assets/platform-icons/cline.png","https://gateway-ui.local/assets/platform-icons/codearts.png","https://gateway-ui.local/assets/platform-icons/codebuddy.png","https://gateway-ui.local/assets/platform-icons/codebuddy-cn.png","https://gateway-ui.local/assets/platform-icons/freeapi.png","https://gateway-ui.local/assets/platform-icons/hailuo.png","https://gateway-ui.local/assets/platform-icons/jimeng.png","https://gateway-ui.local/assets/platform-icons/kling.png","https://gateway-ui.local/assets/platform-icons/liblib.png","https://gateway-ui.local/assets/platform-icons/lobster.png","https://gateway-ui.local/assets/platform-icons/loomy.png","https://gateway-ui.local/assets/platform-icons/minimax.png","https://gateway-ui.local/assets/platform-icons/nvidia.png","https://gateway-ui.local/assets/platform-icons/opencode.png","https://gateway-ui.local/assets/platform-icons/pixverse.png","https://gateway-ui.local/assets/platform-icons/qoder.png","https://gateway-ui.local/assets/platform-icons/qoder-cn.png","https://gateway-ui.local/assets/platform-icons/qwenwork.png","https://gateway-ui.local/assets/platform-icons/raccoon.png","https://gateway-ui.local/assets/platform-icons/trae.png","https://gateway-ui.local/assets/platform-icons/vidu.png","https://gateway-ui.local/assets/platform-icons/workbuddy.png","https://gateway-ui.local/assets/platform-icons/workbuddyai.png","https://gateway-ui.local/assets/platform-icons/xiaoyunque.png","https://gateway-ui.local/assets/platform-icons/zcode.png"}.All(AllowedResource)&&!AllowedResource("https://gateway-ui.local/assets/platform-icons/UNKNOWN.png")&&!AllowedResource("https://other.invalid/assets/platform-icons/hailuo.png");
            checks["managementResourceWhitelist"]=AllowedResource("https://gateway-ui.local/management.js")&&AllowedResource("https://gateway-ui.local/management.css")&&!AllowedResource("https://gateway-ui.local/adapter/management.mjs")&&!AllowedResource("https://gateway-ui.local/desktop.local.json");
            checks["fixedClientActions"]=KnownMethod("client.open")&&KnownMethod("client.shortcut")&&ValidClientRequest(new Dictionary<string,object>{{"targetId","SAMPLE"},{"confirmed",true}})&&!ValidClientRequest(new Dictionary<string,object>{{"targetId","SAMPLE"},{"path","C:\\other.exe"}})&&!ValidClientRequest(new Dictionary<string,object>{{"targetId","../other"}});
            var sampleClient=new Dictionary<string,object>{{"targets",new object[]{new Dictionary<string,object>{{"id","SAMPLE"},{"name","Sample"},{"executable","C:\\SAMPLE\\client.exe"}}}}};
            bool missingRejected=false;try{ClientTarget(sampleClient,"UNKNOWN");}catch(ArgumentException){missingRejected=true;}
            checks["authoritativeClientTarget"]=Json.Text(ClientTarget(sampleClient,"SAMPLE"),"executable")=="C:\\SAMPLE\\client.exe"&&missingRejected;
            return new { passed = checks.Values.Count(x => x), failed = checks.Values.Count(x => !x), checks = checks };
        }
    }

    internal sealed class MainForm : Form {
        private readonly Options options;
        private readonly WebView2 web;
        private readonly string root, profile;
        private readonly SemaphoreSlim snapshotGate = new SemaphoreSlim(1, 1);
        private readonly SemaphoreSlim managementReads = new SemaphoreSlim(2, 2);
        private readonly SemaphoreSlim evidenceGate = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource stopping = new CancellationTokenSource();
        private readonly TaskCompletionSource<bool> navigationReady = new TaskCompletionSource<bool>();
        private readonly NotifyIcon tray = new NotifyIcon();
        private int blockedNavigations, snapshotRequests;
        private bool started, quit, backendStartedByUi, localResourceCacheDisabled;
        private double monitorScale = 1;
        private Rectangle backgroundBounds;
        private string runtimeVersion = "";
        private string currentStage = "host-created", adapterReason = "not-started";
        private int adapterExitCode = -1, adapterOutputChars = 0;
        private CoreWebView2Environment environment;
        internal int ResultCode;

        internal MainForm(Options value) {
            options = value; root = AppDomain.CurrentDomain.BaseDirectory;
            profile = options.SelfTest != null ? Path.Combine(Path.GetTempPath(), "AiCreditWebViewTest-" + Guid.NewGuid().ToString("N")) : options.Portable?Path.Combine(options.UserDataRoot,"webview-profile"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AiCreditGateway", "webview-ui-v1");
            Text = options.Portable?"AI 积分网关 · Web UI "+options.UiVersion:"AI 积分网关 · 本机工作台"; ClientSize = new Size(options.Width, options.Height); MinimumSize = new Size(500, 440);
            Icon = (Icon)AiCreditDesktop.BrandAssets.AppIcon.Clone();
            AutoScaleMode = AutoScaleMode.None; BackColor = Color.FromArgb(243, 246, 247);
            StartPosition = options.SelfTest == null ? FormStartPosition.CenterScreen : FormStartPosition.Manual;
            if (options.SelfTest != null) { Location = new Point(-20000, -20000); ShowInTaskbar = false; }
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            if(options.SelfTest==null) {
                var menu=new ContextMenuStrip();menu.Items.Add("打开主窗口",null,(s,e)=>RestoreVisibleWindow());menu.Items.Add("退出窗口，后台继续",null,(s,e)=>RequestQuit());
                tray.Text="AI网关 · 新版工作台";tray.Icon=Icon;tray.ContextMenuStrip=menu;tray.Visible=true;tray.DoubleClick+=(s,e)=>RestoreVisibleWindow();
                LoadPlacement();if(options.Maximized)WindowState=FormWindowState.Maximized;
                if(options.Background){backgroundBounds=WindowState==FormWindowState.Normal?Bounds:RestoreBounds;WindowState=FormWindowState.Normal;ShowInTaskbar=false;Location=new Point(-20000,-20000);}
            }
            FormClosing += delegate(object sender,FormClosingEventArgs e) {
                if(options.SelfTest==null)SavePlacement();
                if(options.SelfTest==null&&!quit&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();ShowInTaskbar=false;}
            };
            // In-flight async bridge handlers release their gates after closing;
            // process teardown owns the managed semaphores, not FormClosed.
            FormClosed += delegate { stopping.Cancel();tray.Visible=false;tray.Dispose();web.Dispose(); };
        }

        protected override bool ShowWithoutActivation { get { return options.SelfTest != null || options.Background; } }
        protected override CreateParams CreateParams {
            get { var cp = base.CreateParams; if (options != null && (options.SelfTest != null || options.Background)) cp.ExStyle |= 0x08000000 | 0x00000080; return cp; }
        }
        protected override async void OnShown(EventArgs e) {
            base.OnShown(e); if (started) return; started = true;
            try {
                options.EnsurePortableConfiguration();
                CoreWebView2Environment.GetAvailableBrowserVersionString();
                if(options.SelfTest==null)await EnsureBackendRunning();
                await Initialize();
                if(options.Background&&options.SelfTest==null){Hide();ShowInTaskbar=false;Bounds=Recovered(backgroundBounds);if(options.Maximized)WindowState=FormWindowState.Maximized;}
                if (options.SelfTest != null) await SelfTest();
            } catch (Exception error) {
                ResultCode = 1;
                if (options.SelfTest != null) Json.Save(options.SelfTest, new { ok = false, stage = currentStage, errorType = error.GetType().Name, error = Friendly(error), runtime = runtimeVersion, adapterReason = adapterReason, adapterExitCode = adapterExitCode, adapterOutputChars = adapterOutputChars });
                else ShowFailure(Friendly(error));
            } finally { if (options.SelfTest != null) Close(); }
        }

        private void ShowFailure(string message) {
            var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(36), BackColor = BackColor };
            var label = new Label { Dock = DockStyle.Fill, Font = new Font("Microsoft YaHei UI", 12), Text = "界面加载未完成\r\n\r\n" + message + "\r\n\r\n请检查完整安装文件与 WebView2 Runtime，后台服务未被停止。", ForeColor = Color.FromArgb(22, 37, 45) };
            panel.Controls.Add(label); Controls.Add(panel); panel.BringToFront();
            var help=new LinkLabel{Dock=DockStyle.Bottom,Height=58,Text="打开 Microsoft 官方 WebView2 Runtime 下载页",AutoSize=false,LinkColor=Color.Teal};
            help.LinkClicked+=(s,e)=>Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/#download-section"){UseShellExecute=true});panel.Controls.Add(help);help.BringToFront();
            var actions=new FlowLayoutPanel{Dock=DockStyle.Bottom,Height=48};
            string installer=Path.Combine(root,"prerequisites","MicrosoftEdgeWebview2Setup.exe");
            if(File.Exists(installer)){var install=new Button{Text="安装官方 WebView2 Runtime",AutoSize=true};install.Click+=(s,e)=>Process.Start(new ProcessStartInfo(installer){UseShellExecute=true});actions.Controls.Add(install);}
            var retry=new Button{Text="安装后重新检测",AutoSize=true};retry.Click+=async(s,e)=>{retry.Enabled=false;try{CoreWebView2Environment.GetAvailableBrowserVersionString();await EnsureBackendRunning();await Initialize();Controls.Remove(panel);panel.Dispose();}catch(Exception error){label.Text=Friendly(error);retry.Enabled=true;}};actions.Controls.Add(retry);panel.Controls.Add(actions);actions.BringToFront();
        }
        private static string Friendly(Exception e) {
            if (e is WebView2RuntimeNotFoundException || e is DllNotFoundException) return "请安装或修复 Microsoft Edge WebView2 Runtime 后重新打开。";
            if (e is FileNotFoundException || e is DirectoryNotFoundException) return "界面资源或本机连接文件未找到，请重新运行现有桌面快捷方式。";
            if (e is TimeoutException) return "界面加载超时，请关闭新版窗口后重试。";
            return "界面初始化未完成，请查看本机验证记录并重新运行。";
        }

        private async Task EnsureBackendRunning() {
            if(!File.Exists(options.Config))return;
            using(var gateway=new AiCreditDesktop.Gateway(options.Config)) {
                bool start=false;
                if(options.Portable){var config=Json.Object(File.ReadAllText(options.Config,Encoding.UTF8));string data=Json.Text(config,"dataDir");if(!Path.IsPathRooted(data))data=Path.Combine(Path.GetDirectoryName(options.Config),data);start=!File.Exists(Path.Combine(data,"runtime.json"));}
                try{await gateway.Connect(false);}
                catch(Exception error) {
                    var missing=error as FileNotFoundException;
                    start=start||error is HttpRequestException||error is TaskCanceledException||missing!=null&&String.Equals(Path.GetFileName(missing.FileName),"runtime.json",StringComparison.OrdinalIgnoreCase);
                }
                if(start){await StartBackend(gateway);backendStartedByUi=true;}
            }
        }
        private async Task StartBackend(AiCreditDesktop.Gateway gateway) {
            if(!options.Portable){await gateway.Connect(true);return;}
            string entry=Path.Combine(root,"core","bin","ai-credit.mjs");
            using(var process=new Process()) {
                process.StartInfo=new ProcessStartInfo(options.Node,BridgePolicy.Quote(entry)+" start --config "+BridgePolicy.Quote(options.Config)){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root,RedirectStandardOutput=true,RedirectStandardError=true};
                process.StartInfo.EnvironmentVariables["AI_CREDIT_MEMORY"]=Path.Combine(options.UserDataRoot,"memory");
                process.Start();var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();var wait=Task.Run(()=>process.WaitForExit());
                if(await Task.WhenAny(wait,Task.Delay(35000))!=wait){try{process.Kill();}catch{}throw new TimeoutException("后台首次启动超时。");}
                await wait;await stdout;await stderr;if(process.ExitCode!=0)throw new InvalidOperationException("后台首次启动未完成，请查看本包user-data/data/service.log。");
            }
            await gateway.Connect(false);
        }

        private string PlacementFile { get { return options.Portable?Path.Combine(options.UserDataRoot,"window-bounds.json"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AiCreditGateway","webview-window-bounds-"+Program.Identity(options.Config)+".json"); } }
        private Rectangle Recovered(Rectangle value) {
            return AiCreditDesktop.MainWindow.RecoverWindowBounds(value,Screen.AllScreens.Select(s=>s.WorkingArea).ToArray(),Screen.PrimaryScreen.WorkingArea);
        }
        private void LoadPlacement() {
            Rectangle bounds=new Rectangle(options.Left??Left,options.Top??Top,options.Width,options.Height);bool use=options.Left.HasValue&&options.Top.HasValue;
            if(!use&&File.Exists(PlacementFile))try{var stored=Json.Object(File.ReadAllText(PlacementFile,Encoding.UTF8));bounds=new Rectangle(Convert.ToInt32(stored["left"]),Convert.ToInt32(stored["top"]),Convert.ToInt32(stored["width"]),Convert.ToInt32(stored["height"]));options.Maximized=Object.Equals(stored["maximized"],true);use=true;}catch{}
            if(use){StartPosition=FormStartPosition.Manual;Bounds=Recovered(bounds);}
        }
        private void SavePlacement() {
            try{Rectangle b=Recovered(WindowState==FormWindowState.Normal?Bounds:RestoreBounds);Json.Save(PlacementFile,new{left=b.Left,top=b.Top,width=b.Width,height=b.Height,maximized=WindowState==FormWindowState.Maximized});}catch{}
        }
        internal void RestoreVisibleWindow() {
            if(IsDisposed||Disposing)return;bool maximized=WindowState==FormWindowState.Maximized;
            Rectangle original=WindowState==FormWindowState.Normal?Bounds:RestoreBounds;Rectangle b=Recovered(original);
            if(WindowState==FormWindowState.Minimized||b!=original){WindowState=FormWindowState.Normal;Bounds=b;}
            ShowInTaskbar=true;Show();if(maximized)WindowState=FormWindowState.Maximized;BringToFront();Activate();
        }
        internal void RequestQuit() { quit=true;Close(); }
        private static string FileHash(string file) { using(var sha=SHA256.Create())using(var stream=File.OpenRead(file))return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
        private async Task CaptureBounded(string image) {
            // Do not create a zero-byte image before WebView2 has completed the
            // capture. A disabled/minimized owner must not hold the IPC open.
            var memory=new MemoryStream();Task capture;
            try{capture=web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,memory);}catch{memory.Dispose();throw;}
            if(await Task.WhenAny(capture,Task.Delay(8000))!=capture){Task cleanup=capture.ContinueWith(t=>{var ignored=t.Exception;memory.Dispose();},TaskScheduler.Default);throw new TimeoutException("CapturePreview timeout");}
            try{await capture;File.WriteAllBytes(image,memory.ToArray());}finally{memory.Dispose();}
        }
        private async Task NavigateManagementPage(string page) {
            page=BridgePolicy.NormalizePage(page);
            await Eval("window.gatewayUI.navigate("+Json.Encode(page)+");true");
            string ready="window.gatewayUI.getState().page==="+Json.Encode(page);
            if(page.StartsWith("manage-",StringComparison.Ordinal))ready+="&&!!window.GatewayManagement&&window.GatewayManagement.getState().section==="+Json.Encode(page.Substring(7))+"&&!window.GatewayManagement.getState().loading&&!!document.querySelector('#managementContent[data-management-section=\""+page.Substring(7)+"\"]')";
            await WaitFor(ready,35000);
        }
        internal async Task WriteInstanceEvidence(string output,string nonce,string page) {
            string stage="resident-request",image=Path.ChangeExtension(output,".png");object state=null;
            bool entered=await evidenceGate.WaitAsync(0);
            if(!entered){Json.Save(output,new{ok=false,nonce=nonce,stage="resident-evidence-busy",source="resident-single-instance-webview"});return;}
            try {
                Json.Save(output,new{ok=false,pending=true,nonce=nonce,pid=Process.GetCurrentProcess().Id,stage=stage,requestedPage=page,source="resident-single-instance-webview"});
                var initializing=Stopwatch.StartNew();while(!CurrentAllowed&&initializing.ElapsedMilliseconds<15000)await Task.Delay(120);
                await WaitFor("!!window.gatewayUI&&!!window.gatewayUI.getState().snapshot",10000);
                if(page!=null){stage="resident-navigate-"+page;await NavigateManagementPage(page);}
                stage="resident-dom";
                state=await Eval(@"(function(){const s=window.gatewayUI.getState(),d=s.snapshot,m=window.GatewayManagement&&window.GatewayManagement.getState(),e=document.querySelector('#managementContent'),n=['overview','accounts','routes','records'].map(p=>document.querySelector('[data-nav='+p+']')).filter(Boolean).map(x=>x.getBoundingClientRect());return {title:document.title,origin:location.href,page:s.page,accountCount:d.accounts.length,routeCount:d.routes.length,recordCount:d.records.length,serviceVersion:d.service.version,serviceOnline:d.service.online,mode:d.mode,horizontalNavigation:n.length===4&&Math.max(...n.map(r=>r.y))-Math.min(...n.map(r=>r.y))<5,hasCommandPalette:!!document.querySelector('#commandDialog'),managementSection:e&&e.dataset.managementSection,managementLoading:!!(m&&m.loading),managementError:m&&m.error||'',managementDataReady:!!(m&&m.data),managementControls:e&&e.querySelectorAll('button,input,select,textarea').length,managementRows:e&&e.querySelectorAll('tr,[data-wb-select]').length,selectedWorkbuddyAccount:document.querySelector('#wbDetailPane')?.dataset.selectedAccount||null,platformLogoCount:document.querySelectorAll('img[data-platform-logo]').length,loadedLogoCount:[...document.querySelectorAll('img[data-platform-logo]')].filter(x=>x.complete&&x.naturalWidth>0).length,visibleButtons:[...document.querySelectorAll('button')].filter(x=>x.getBoundingClientRect().width>0).map(x=>x.textContent.trim()).slice(0,35)};})()");
                stage="resident-capture";Json.Save(output,new{ok=false,pending=true,nonce=nonce,pid=Process.GetCurrentProcess().Id,stage=stage,requestedPage=page,dom=state,source="resident-single-instance-webview"});
                await CaptureBounded(image);
                string executable=Process.GetCurrentProcess().MainModule.FileName;Rectangle b=Bounds;
                var dom=state as Dictionary<string,object>;bool loaded=dom!=null&&String.IsNullOrEmpty(Json.Text(dom,"managementError"))&&(page==null||Json.Text(dom,"page")==page);
                Json.Save(output,new{ok=loaded,pending=false,stage="resident-complete",requestedPage=page,nonce=nonce,pid=Process.GetCurrentProcess().Id,executable=executable,executableSha256=FileHash(executable),uiSha256=FileHash(Path.Combine(root,"ui","index.html")),runtime=runtimeVersion,localResourceCacheDisabled=localResourceCacheDisabled,visible=Visible,minimized=WindowState==FormWindowState.Minimized,bounds=new{left=b.Left,top=b.Top,width=b.Width,height=b.Height},onScreen=Screen.AllScreens.Any(s=>Rectangle.Intersect(b,s.WorkingArea).Width>0&&Rectangle.Intersect(b,s.WorkingArea).Height>0),dom=state,capture=image,source="resident-single-instance-webview",backendStartedByUi=backendStartedByUi,portable=options.Portable,uiVersion=options.UiVersion,configFile=options.Config,profile=profile,userDataRoot=options.UserDataRoot,nativeManagementWindows=Application.OpenForms.OfType<AiCreditDesktop.MainWindow>().Count()});
            }catch(Exception error){Json.Save(output,new{ok=false,pending=false,nonce=nonce,pid=Process.GetCurrentProcess().Id,stage=stage,requestedPage=page,dom=state,errorType=error.GetType().Name,capture=File.Exists(image)?image:null,source="resident-single-instance-webview"});}
            finally{evidenceGate.Release();}
        }

        private async Task Initialize() {
            currentStage = "webview-initialize";
            string ui = Path.Combine(root, "ui");
            if (!File.Exists(Path.Combine(ui, "index.html"))) throw new FileNotFoundException();
            runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
            var envOptions = new CoreWebView2EnvironmentOptions();
            envOptions.AdditionalBrowserArguments = "--disable-background-networking --disable-component-update --no-first-run";
            environment = await CoreWebView2Environment.CreateAsync(null, profile, envOptions);
            await web.EnsureCoreWebView2Async(environment);
            using (var graphics = CreateGraphics()) monitorScale = graphics.DpiX / 96.0;
            // Self-test sizes are physical client pixels. Normalize the inherited
            // monitor scale so --scale 1/1.25/1.5 has the stated effective CSS size.
            web.ZoomFactor = options.SelfTest != null ? options.Scale / monitorScale : options.Scale;
            var core = web.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            // Reuse the resident profile and its preferences without accepting
            // old JS/CSS from HTTP/disk cache after an in-place application update.
            // This affects this WebView's Network session only, not cookies/data.
            currentStage="disable-local-resource-cache";
            await core.CallDevToolsProtocolMethodAsync("Network.enable","{}");
            await core.CallDevToolsProtocolMethodAsync("Network.setCacheDisabled","{\"cacheDisabled\":true}");
            localResourceCacheDisabled=true;
            core.SetVirtualHostNameToFolderMapping("gateway-ui.local", ui, CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter("http*://*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args) {
                if (!BridgePolicy.AllowedResource(args.Request.Uri)) {
                    args.Response = environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes("Local resources only")), 403, "Forbidden", "Content-Type: text/plain; charset=utf-8");
                }
            };
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { if (!BridgePolicy.AllowedUri(args.Uri)) { args.Cancel = true; blockedNavigations++; } };
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { args.Cancel = true; blockedNavigations++; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) { args.Handled = true; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) { args.Cancel = true; args.Handled = true; };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) { args.State = CoreWebView2PermissionState.Deny; args.Handled = true; };
            core.WebMessageReceived += OnMessage;
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) { if (args.IsSuccess && BridgePolicy.AllowedUri(core.Source)) navigationReady.TrySetResult(true); else navigationReady.TrySetException(new InvalidOperationException("Local page did not load")); };
            core.Navigate(BridgePolicy.Home);
            if (await Task.WhenAny(navigationReady.Task, Task.Delay(25000)) != navigationReady.Task) throw new TimeoutException();
            await navigationReady.Task;
            if(options.Portable)await Eval("(function(){const label=document.querySelector('.window-bar>span>span');if(label)label.textContent='Web UI '+"+Json.Encode(options.UiVersion)+";document.title='AI 积分网关 · Web UI '+"+Json.Encode(options.UiVersion)+";window.__gatewayPortableRelease="+Json.Encode(new{uiVersion=options.UiVersion,backendVersion="0.8.1"})+";return true;})()");
            currentStage = "local-page-loaded";
        }

        private bool CurrentAllowed { get { return web.CoreWebView2 != null && BridgePolicy.AllowedUri(web.CoreWebView2.Source); } }
        private void Reply(string id, bool ok, object result, string error) {
            if (stopping.IsCancellationRequested || !CurrentAllowed) return;
            web.CoreWebView2.PostWebMessageAsJson(ok ? Json.Encode(new { id = id, ok = true, result = result }) : Json.Encode(new { id = id, ok = false, error = error }));
        }
        private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
            if (!BridgePolicy.AllowedUri(e.Source) || !CurrentAllowed || stopping.IsCancellationRequested) return;
            string id = "", activeMethod="";
            try {
                string text = e.WebMessageAsJson;
                if (text == null || text.Length > 8*1024*1024) return;
                var message = Json.Object(text); id = Json.Text(message, "id");
                if (!BridgePolicy.ValidId(id)) return;
                string method = Json.Text(message, "method");activeMethod=method;
                if (!BridgePolicy.KnownMethod(method)) { Reply(id, false, null, "当前界面未开放此操作。"); return; }
                if(!method.StartsWith("management.",StringComparison.Ordinal)&&text.Length>16384){Reply(id,false,null,"操作参数超过大小限制。");return;}
                if (method == "snapshot") {
                    if (!await snapshotGate.WaitAsync(0)) { Reply(id, false, null, "正在读取最新状态，请稍候再刷新。"); return; }
                    try { snapshotRequests++; object snapshot = await ReadSnapshot(); Reply(id, true, snapshot, null); }
                    finally { snapshotGate.Release(); }
                    return;
                }
                object rawArgs;message.TryGetValue("params",out rawArgs);var args=rawArgs as Dictionary<string,object>;
                if(method=="client.open"||method=="client.shortcut") {
                    if(!BridgePolicy.ValidClientRequest(args)){Reply(id,false,null,"客户端操作参数未通过校验。");return;}
                    if(!Object.Equals(args.ContainsKey("confirmed")?args["confirmed"]:false,true)||options.Demo||options.SelfTest!=null){Reply(id,true,new{operation=new{kind=method,status="cancelled",message="未打开客户端或创建快捷方式。"}},null);return;}
                    if(!await snapshotGate.WaitAsync(0)){Reply(id,false,null,"已有读取或操作进行中，请稍候。");return;}
                    try{Reply(id,true,await RunClientAction(method,Json.Text(args,"targetId")),null);}finally{snapshotGate.Release();}return;
                }
                if(method=="gateway.lifecycle") {
                    if(!BridgePolicy.ValidLifecycle(args)){Reply(id,false,null,"后台控制参数未通过校验。");return;}
                    string action=Json.Text(args,"action");
                    if(!Object.Equals(args.ContainsKey("confirmed")?args["confirmed"]:false,true)||options.Demo||options.SelfTest!=null){Reply(id,true,new{operation=new{kind=action,status="cancelled",message="未执行后台生命周期操作。"}},null);return;}
                    if(!await snapshotGate.WaitAsync(0)){Reply(id,false,null,"已有读取或操作进行中，请稍候再控制后台。");return;}
                    try {
                        using(var gateway=new AiCreditDesktop.Gateway(options.Config)) {
                            if(action=="server.start"){await StartBackend(gateway);backendStartedByUi=true;}
                            else{await gateway.Connect(false);await gateway.Request("POST","/admin/shutdown",new object());}
                        }
                        Reply(id,true,new{operation=new{kind=action,status="completed",message=action=="server.start"?"后台已启动或已连接。":"暂停请求已返回，后台不会被页面自动重启。"},paused=action=="server.stop"},null);
                    }finally{snapshotGate.Release();}return;
                }
                if(method=="gateway.action") {
                    if(!BridgePolicy.ValidAction(args)){Reply(id,false,null,"操作参数未通过校验。");return;}
                    if(options.Demo||options.SelfTest!=null){Reply(id,false,null,"演示或自动验收不提交真实操作。");return;}
                    if(!await snapshotGate.WaitAsync(0)){Reply(id,false,null,"已有读取或操作进行中，请等待结果。");return;}
                    try{object result=await ReadAdapter("control.mjs",Json.Encode(args),180000);Reply(id,true,result,null);}finally{snapshotGate.Release();}return;
                }
                if(method=="management.read"||method=="management.action") {
                    bool action=method=="management.action";
                    if(!BridgePolicy.ValidManagement(args,action)){Reply(id,false,null,"管理页面参数未通过校验。");return;}
                    var request=new Dictionary<string,object>(args);request["method"]=action?"action":"read";
                    if(action) {
                        if(!Object.Equals(args.ContainsKey("confirmed")?args["confirmed"]:false,true)){Reply(id,true,new{operation=new{kind=Json.Text(args,"action"),status="cancelled",message="操作未确认，未发送请求。"}},null);return;}
                        if(options.Demo||options.SelfTest!=null){Reply(id,true,new{operation=new{kind=Json.Text(args,"action"),status="cancelled",message="演示或自动验收未执行真实管理操作。"}},null);return;}
                        if(!await snapshotGate.WaitAsync(0)){Reply(id,false,null,"已有操作进行中，请等待结果。");return;}
                        try{Reply(id,true,await RunManagementAction(request),null);}finally{snapshotGate.Release();}
                    }else {
                        if(!await managementReads.WaitAsync(5000)){Reply(id,false,null,"页面读取排队中，请稍后重新读取。");return;}
                        try{Reply(id,true,await ReadAdapter("management.mjs",Json.Encode(request),90000),null);}finally{managementReads.Release();}
                    }
                    return;
                }
                Reply(id, true, new { accepted = true }, null);
                if (options.SelfTest != null) return;
                if (method == "window.minimize") WindowState = FormWindowState.Minimized;
                else if (method == "window.maximize") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                else if (method == "window.close") BeginInvoke(new Action(Close));
            } catch (Exception) { if (BridgePolicy.ValidId(id)) Reply(id, false, null, activeMethod=="gateway.action"||activeMethod=="management.action"||activeMethod=="gateway.lifecycle"||activeMethod.StartsWith("client.",StringComparison.Ordinal)?"操作结果尚未确认，请核对后台或对应记录；本窗口不会自动重试。":activeMethod=="management.read"?"管理页面暂未读完，请确认后台连接后重新读取。":"状态读取暂未完成，请确认后台仍在运行后重试。"); }
        }

        private async Task<object> RunManagementAction(Dictionary<string,object> request) {
            string action=Json.Text(request,"action"),destination=null;
            bool export=action=="wb.export"||action=="operations.keyCreate";
            if(export)using(var dialog=new SaveFileDialog()) {
                object rawValues;request.TryGetValue("values",out rawValues);var values=rawValues as Dictionary<string,object>;bool zip=action=="wb.export"&&Json.Text(values,"format")=="zip";
                dialog.Title=action=="wb.export"?"保存 WorkBuddy 账号备份":"保存新建应用密钥";
                dialog.FileName=action=="wb.export"?"workbuddy-accounts-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+(zip?".zip":".json"):"gateway-client-key.txt";
                dialog.DefaultExt=action=="wb.export"?(zip?"zip":"json"):"txt";dialog.Filter=action=="wb.export"?(zip?"ZIP 备份 (*.zip)|*.zip|所有文件 (*.*)|*.*":"JSON 备份 (*.json)|*.json|所有文件 (*.*)|*.*"):"文本文件 (*.txt)|*.txt";
                dialog.AddExtension=true;dialog.OverwritePrompt=true;dialog.CheckPathExists=true;
                if(dialog.ShowDialog(this)!=DialogResult.OK)return new{operation=new{kind=action,status="cancelled",message="已取消保存，未发送导出或创建请求。"},saved=false};
                destination=Path.GetFullPath(dialog.FileName);
                if(destination.StartsWith("\\\\",StringComparison.Ordinal))return new{operation=new{kind=action,status="cancelled",message="请选择本机磁盘保存文件，未发送请求。"},saved=false};
            }
            var result=(Dictionary<string,object>)await ReadAdapter("management.mjs",Json.Encode(request),180000);
            object exportRaw,externalRaw;result.TryGetValue("export",out exportRaw);result.TryGetValue("external",out externalRaw);
            result.Remove("export");result.Remove("external");
            try {
                if(exportRaw!=null) {
                    var payload=exportRaw as Dictionary<string,object>;
                    if(!export||destination==null||payload==null||!payload.ContainsKey("content")||!(payload["content"] is string))throw new InvalidOperationException();
                    string content=Json.Text(payload,"content"),encoding=Json.Text(payload,"encoding");
                    byte[] bytes=encoding=="base64"?Convert.FromBase64String(content):encoding=="utf8"?new UTF8Encoding(false).GetBytes(content):null;
                    if(bytes==null||bytes.Length>8*1024*1024)throw new InvalidOperationException();
                    File.WriteAllBytes(destination,bytes);result["saved"]=true;result["fileName"]=Path.GetFileName(destination);
                }
                if(externalRaw!=null) {
                    var external=externalRaw as Dictionary<string,object>;string url=Json.Text(external,"url");
                    if(action!="wb.loginStart"||Json.Text(external,"kind")!="workbuddy-login"||!BridgePolicy.AllowedExternalLogin(url))throw new InvalidOperationException();
                    Process.Start(new ProcessStartInfo(url){UseShellExecute=true});result["openedExternal"]=true;
                }
            }catch{result["operation"]=new{kind=action,status="uncertain",message="后台已返回结果，但本机保存或登录页打开未完成；请核对后处理，未自动重试。"};result["saved"]=false;}
            return result;
        }

        private async Task<object> RunClientAction(string method,string targetId) {
            Dictionary<string,object> report;
            using(var gateway=new AiCreditDesktop.Gateway(options.Config)){await gateway.Connect(false);report=await gateway.Request("GET","/admin/client-updates");}
            var target=BridgePolicy.ClientTarget(report,targetId);string exe=Path.GetFullPath(Json.Text(target,"executable"));
            if(!File.Exists(exe))return new{operation=new{kind=method,status="failed",message="所选客户端的启动程序尚未找到，请重新检测安装信息。"},targetId=targetId};
            if(method=="client.open") {
                Process.Start(new ProcessStartInfo{FileName=exe,WorkingDirectory=Path.GetDirectoryName(exe),UseShellExecute=true});
                return new{operation=new{kind=method,status="completed",message="已向系统提交打开所选客户端。"},targetId=targetId};
            }
            string name=Json.Text(target,"name");if(String.IsNullOrWhiteSpace(name))name=targetId;
            name=new string(name.Take(100).Select(c=>Path.GetInvalidFileNameChars().Contains(c)?'_':c).ToArray()).Trim().TrimEnd('.');if(name.Length==0)name=targetId;
            string link=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),name+".lnk");
            if(File.Exists(link)&&MessageBox.Show(this,"桌面已有同名快捷方式，是否替换？",name,MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return new{operation=new{kind=method,status="cancelled",message="已保留原桌面快捷方式。"},targetId=targetId};
            object shell=null,shortcut=null;
            try {
                shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                shortcut=shell.GetType().InvokeMember("CreateShortcut",System.Reflection.BindingFlags.InvokeMethod,null,shell,new object[]{link});
                foreach(var field in new Dictionary<string,string>{{"TargetPath",exe},{"WorkingDirectory",Path.GetDirectoryName(exe)},{"IconLocation",exe+",0"},{"Description",name+" · 由 AI网关创建"}})shortcut.GetType().InvokeMember(field.Key,System.Reflection.BindingFlags.SetProperty,null,shortcut,new object[]{field.Value});
                shortcut.GetType().InvokeMember("Save",System.Reflection.BindingFlags.InvokeMethod,null,shortcut,null);
                if(!File.Exists(link))throw new IOException();
            }finally{if(shortcut!=null&&Marshal.IsComObject(shortcut))Marshal.FinalReleaseComObject(shortcut);if(shell!=null&&Marshal.IsComObject(shell))Marshal.FinalReleaseComObject(shell);}
            return new{operation=new{kind=method,status="completed",message="所选客户端的桌面快捷方式已创建。"},targetId=targetId};
        }

        private async Task<object> ReadSnapshot() {
            return await ReadAdapter("snapshot.mjs",null,30000);
        }
        private async Task<object> ReadAdapter(string file,string request,int timeout) {
            if(file!="snapshot.mjs"&&file!="control.mjs"&&file!="management.mjs")throw new ArgumentException();
            string adapter = Path.Combine(root, "adapter", file);
            adapterReason = "checking-files";
            if (!File.Exists(adapter)) { adapterReason = "adapter-file-missing"; throw new FileNotFoundException(); }
            if (!File.Exists(options.Node)) { adapterReason = "node-file-missing"; throw new FileNotFoundException(); }
            if (!options.Demo && !File.Exists(options.Config)) { adapterReason = "config-reference-missing"; throw new FileNotFoundException(); }
            bool stdin=file=="management.mjs"&&request!=null;
            string args = BridgePolicy.Quote(adapter) + (options.Demo&&file=="snapshot.mjs" ? " --demo" : " --config " + BridgePolicy.Quote(options.Config))+(request==null?"":stdin?" --request-stdin":" --request "+BridgePolicy.Quote(request));
            using (var process = new Process()) {
                process.StartInfo = new ProcessStartInfo(options.Node, args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput=stdin,StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
                if(options.Portable)process.StartInfo.EnvironmentVariables["AI_CREDIT_MEMORY"]=Path.Combine(options.UserDataRoot,"memory");
                adapterReason = "adapter-running"; process.Start();
                if(stdin){byte[] inputBytes=Encoding.UTF8.GetBytes(request);await process.StandardInput.BaseStream.WriteAsync(inputBytes,0,inputBytes.Length);process.StandardInput.Close();}
                Task<string> stdout = process.StandardOutput.ReadToEndAsync(), stderr = process.StandardError.ReadToEndAsync();
                Task wait = Task.Run(() => process.WaitForExit());
                Task winner = await Task.WhenAny(wait, Task.Delay(timeout, stopping.Token));
                if (winner != wait) { adapterReason = "adapter-timeout"; try { if (!process.HasExited) process.Kill(); } catch { } throw new TimeoutException(); }
                await wait; string data = await stdout; await stderr;
                adapterExitCode = process.ExitCode; adapterOutputChars = data.Length;
                if (process.ExitCode != 0) { adapterReason = "adapter-exit-nonzero"; throw new InvalidOperationException(); }
                if (data.Length > (file=="management.mjs"?12:2) * 1024 * 1024) { adapterReason = "adapter-output-too-large"; throw new InvalidOperationException(); }
                Dictionary<string, object> obj;
                try { obj = Json.Object(data); } catch { adapterReason = "adapter-json-invalid"; throw; }
                object operation;obj.TryGetValue("operation",out operation);
                var operationObject=operation as Dictionary<string,object>;
                bool schema=file=="snapshot.mjs"?obj.ContainsKey("service")&&obj.ContainsKey("accounts")&&obj.ContainsKey("mode"):file=="management.mjs"?obj.ContainsKey("data")&&obj.ContainsKey("section")||operationObject!=null&&new[]{"completed","partial","uncertain","failed","cancelled"}.Contains(Json.Text(operationObject,"status")):operationObject!=null&&new[]{"completed","partial","uncertain","failed"}.Contains(Json.Text(operationObject,"status"));
                if (!schema) { adapterReason = "adapter-schema-invalid"; throw new InvalidOperationException(); }
                adapterReason = "ok";
                return obj;
            }
        }

        private async Task<object> Eval(string expression) {
            if (!CurrentAllowed) throw new InvalidOperationException();
            var script=web.CoreWebView2.ExecuteScriptAsync(expression);
            if(await Task.WhenAny(script,Task.Delay(5000))!=script)throw new TimeoutException("DOM evaluation timeout");
            string raw = await script;
            return Json.Codec.DeserializeObject(raw);
        }
        private async Task WaitFor(string expression, int timeout) {
            var timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < timeout) {
                object value = await Eval(expression);
                if (Object.Equals(value, true)) return;
                await Task.Delay(120);
            }
            throw new TimeoutException();
        }
        private async Task<Dictionary<string, object>> RequestTestBridge(string id, string method,object args=null) {
            string payload = Json.Encode(new { id = id, method = method, @params = args??new { } });
            await Eval("(function(){window.__hostBridgeResult=null;const h=e=>{if(e.data&&e.data.id===" + Json.Encode(id) + "){window.__hostBridgeResult=e.data;window.chrome.webview.removeEventListener('message',h);}};window.chrome.webview.addEventListener('message',h);window.chrome.webview.postMessage(" + payload + ");return true;})()");
            await WaitFor("window.__hostBridgeResult!==null", 35000);
            return (Dictionary<string, object>)await Eval("window.__hostBridgeResult");
        }

        private async Task SelfTest() {
            currentStage = "selftest-wait-page-api";
            await WaitFor("!!window.gatewayUI", 15000);
            // Let the page's initial automatic snapshot finish before exercising a second request.
            var wait = Stopwatch.StartNew(); while (snapshotGate.CurrentCount == 0 && wait.ElapsedMilliseconds < 35000) await Task.Delay(100);
            await Task.Delay(500);
            currentStage = "selftest-snapshot-bridge";
            var reply = await RequestTestBridge("host-selftest", "snapshot");
            bool bridgeOk = reply.ContainsKey("ok") && Object.Equals(reply["ok"], true);
            if (!bridgeOk) throw new InvalidOperationException("Snapshot bridge test did not pass");
            currentStage = "selftest-unknown-method";
            var denied = await RequestTestBridge("host-denied", "claim");
            bool denyOk = Object.Equals(denied["ok"], false);
            if (!denyOk) throw new InvalidOperationException("Unknown method was not rejected");
            var invalidAction=await RequestTestBridge("host-invalid-action","gateway.action");
            var invalidTool=await RequestTestBridge("host-invalid-tool","tools.open");
            var invalidManagement=await RequestTestBridge("host-invalid-management","management.read");
            var stoppedTest=await RequestTestBridge("host-stop-cancelled","gateway.lifecycle",new{action="server.stop",confirmed=true});
            var startedTest=await RequestTestBridge("host-start-cancelled","gateway.lifecycle",new{action="server.start",confirmed=true});
            var exportedTest=await RequestTestBridge("host-export-cancelled","management.action",new{action="wb.export",confirmed=true});
            var clientOpenTest=await RequestTestBridge("host-client-open-cancelled","client.open",new{targetId="SAMPLE",confirmed=true});
            var clientShortcutTest=await RequestTestBridge("host-client-shortcut-cancelled","client.shortcut",new{targetId="SAMPLE",confirmed=true});
            bool mutationSuppressed=new[]{stoppedTest,startedTest,exportedTest,clientOpenTest,clientShortcutTest}.All(v=>Object.Equals(v["ok"],true)&&Json.Text((v["result"] as Dictionary<string,object>)["operation"] as Dictionary<string,object>,"status")=="cancelled");
            bool businessPolicyOk=Object.Equals(invalidAction["ok"],false)&&Object.Equals(invalidTool["ok"],false)&&Object.Equals(invalidManagement["ok"],false)&&mutationSuppressed;
            if(!businessPolicyOk)throw new InvalidOperationException("Invalid business arguments were accepted");
            currentStage = "selftest-ui-interactions";
            var interaction = (Dictionary<string, object>)await Eval(@"(function(){
                const out={gatewayUI:!!window.gatewayUI,body:!!document.body,ready:document.readyState};
                for(const page of ['accounts','routes','records']){
                    const n=document.querySelector('[data-nav='+page+']');
                    if(n){n.click();out[page+'Navigation']=window.gatewayUI.getState().page===page;}
                }
                const s=document.querySelector('[data-action=settings]');
                if(s){s.click();out.settingsOpened=!!document.querySelector('dialog[open]');}
                window.__hostThemeBefore=document.documentElement.dataset.theme;
                const theme=document.querySelector('[data-setting=theme]');
                if(theme){theme.value='dark';theme.dispatchEvent(new Event('change',{bubbles:true}));out.themePreview=document.documentElement.dataset.theme==='dark';}
                return out;
            })()");
            await Eval("(function(){document.querySelectorAll('dialog[open]').forEach(d=>d.close());const n=document.querySelector('[data-nav=\"overview\"]');if(n)n.click();return true;})()");
            await Task.Delay(400);
            interaction["themeRestored"] = await Eval("document.documentElement.dataset.theme===window.__hostThemeBefore");
            interaction["overviewNavigation"] = await Eval("window.gatewayUI.getState().page==='overview'");
            currentStage = "selftest-redesigned-workflow";
            var redesigned = (Dictionary<string, object>)await Eval(@"(function(){
                const out={};
                const nav=['overview','accounts','routes','records'].map(p=>document.querySelector('[data-nav='+p+']').getBoundingClientRect());
                out.horizontalNavigation=Math.max(...nav.map(r=>r.y))-Math.min(...nav.map(r=>r.y))<5;
                window.gatewayUI.navigate('accounts');
                const entries=[...document.querySelectorAll('[data-account-select]')];
                if(entries.length>1){
                    entries[1].click();
                    out.directorySelection=document.querySelector('#accountDetailPane').dataset.selectedAccount===entries[1].dataset.accountSelect;
                    document.querySelector('[data-account-select]').click();
                    const first=document.querySelector('[data-account-select]'); first.focus();
                    const before=document.querySelector('#accountDetailPane').dataset.selectedAccount;
                    first.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
                    out.keyboardSelection=document.querySelector('#accountDetailPane').dataset.selectedAccount!==before;
                }else if(window.gatewayUI.getState().snapshot.accounts.length===0){out.directorySelection=true;out.keyboardSelection=true;out.emptyDirectoryHandled=true;}
                return out;
            })()");
            foreach (var pair in redesigned) interaction[pair.Key] = pair.Value;
            Directory.CreateDirectory(Path.GetDirectoryName(options.SelfTest));
            string evidenceStem = Path.Combine(Path.GetDirectoryName(options.SelfTest), Path.GetFileNameWithoutExtension(options.SelfTest));
            await CaptureBounded(evidenceStem+"-accounts.png");
            await Eval(@"(function(){
                const a=window.gatewayUI.getState().snapshot.accounts;
                window.__commandTarget=a.find(x=>x.platform==='liblib')||a[0];
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
                const input=document.querySelector('#commandSearch'); input.value=window.__commandTarget?window.__commandTarget.label:'总览';
                input.dispatchEvent(new Event('input',{bubbles:true}));return true;
            })()");
            await CaptureBounded(evidenceStem+"-command.png");
            interaction["commandPalette"] = await Eval(@"(function(){
                const open=document.querySelector('#commandDialog').open;
                document.querySelector('#commandSearch').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
                if(!window.__commandTarget)return open&&!document.querySelector('#commandDialog').open&&window.gatewayUI.getState().page==='overview';
                return open&&!document.querySelector('#commandDialog').open&&window.gatewayUI.getState().page==='accounts'&&document.querySelector('#accountDetailPane').dataset.selectedAccount===window.__commandTarget.id;
            })()");
            await Eval("window.gatewayUI.navigate('overview');true");
            string[] required = { "accountsNavigation", "routesNavigation", "recordsNavigation", "settingsOpened", "themePreview", "themeRestored", "overviewNavigation", "horizontalNavigation", "directorySelection", "keyboardSelection", "commandPalette" };
            bool uiOk = required.All(k => interaction.ContainsKey(k) && Object.Equals(interaction[k], true));
            object layout = await Eval("({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,title:document.title})");
            object state = await Eval("(function(){const s=window.gatewayUI.getState?window.gatewayUI.getState():null;const d=s&&s.snapshot;return {hasState:!!s,keys:s?Object.keys(s):[],snapshotMode:d&&d.mode,accountCount:d&&d.accounts&&d.accounts.length,routeCount:d&&d.routes&&d.routes.length,recordCount:d&&d.records&&d.records.length,serviceVersion:d&&d.service&&d.service.version};})()");
            string capture = options.Capture ?? Path.ChangeExtension(options.SelfTest, ".png");
            Directory.CreateDirectory(Path.GetDirectoryName(capture));
            currentStage = "selftest-capture";
            await CaptureBounded(capture);
            int previous = blockedNavigations; web.CoreWebView2.Navigate("https://example.invalid/"); await Task.Delay(250);
            bool navigationBlocked = blockedNavigations > previous && CurrentAllowed;
            var snapshot = (Dictionary<string, object>)reply["result"];
            object managementTools=BridgePolicy.ManagementContract();
            var managementPages=new List<object>();bool managementOk=true;
            foreach(string section in BridgePolicy.ManagementSections) {
                currentStage="selftest-web-management-"+section;
                await NavigateManagementPage("manage-"+section);
                var m=(Dictionary<string,object>)await Eval("(function(){const m=window.GatewayManagement.getState(),e=document.querySelector('#managementContent');return {section:m.section,loading:m.loading,error:m.error,dataReady:!!m.data,marker:e&&e.dataset.managementSection,controls:e&&e.querySelectorAll('button,input,select,textarea').length,overflow:document.documentElement.scrollWidth>innerWidth+1};})()");
                bool pass=Json.Text(m,"section")==section&&Json.Text(m,"marker")==section&&String.IsNullOrEmpty(Json.Text(m,"error"))&&Object.Equals(m["dataReady"],true)&&!Object.Equals(m["loading"],true)&&!Object.Equals(m["overflow"],true);
                string image=evidenceStem+"-manage-"+section+".png";await CaptureBounded(image);
                managementPages.Add(new{section=section,ok=pass,dom=m,capture=image});managementOk=managementOk&&pass;
            }
            await Eval("window.gatewayUI.navigate('overview');true");
            Json.Save(options.SelfTest, new {
                ok = bridgeOk && denyOk && navigationBlocked && uiOk && businessPolicyOk && managementOk,
                mode = Json.Text(snapshot, "mode"), runtime = runtimeVersion, origin = BridgePolicy.Home,
                hidden = true, noActivate = true, width = options.Width, height = options.Height,
                requestedVisualScale = options.Scale, zoomFactor = web.ZoomFactor, inheritedMonitorScale = monitorScale,
                snapshotBridge = bridgeOk, unknownMethodRejected = denyOk, externalNavigationBlocked = navigationBlocked,
                portable=options.Portable,uiVersion=options.UiVersion,configFile=options.Config,profile=profile,userDataRoot=options.UserDataRoot,snapshotRequests = snapshotRequests, localResourceCacheDisabled=localResourceCacheDisabled, interaction = interaction, state = state, layout = layout,
                capture = capture, nativeContract = BridgePolicy.Contract(), businessPolicy=businessPolicyOk,mutatingSelfTestsCancelled=mutationSuppressed,managementTools=managementTools,managementPages=managementPages,nativeManagementWindows=Application.OpenForms.OfType<AiCreditDesktop.MainWindow>().Count()
            });
            if (!navigationBlocked || !uiOk || !businessPolicyOk || !managementOk) ResultCode = 1;
        }
    }

    internal static class Program {
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        internal static string Identity(string config) { using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(config.ToLowerInvariant()))).Replace("-",""); }
        private static string ControlFile(Options options,string hash) { return Path.Combine(options.Portable?options.UserDataRoot:AppDomain.CurrentDomain.BaseDirectory,"ui-control-"+hash+".json"); }
        private static int SignalExisting(Options options,string hash) {
            try {
                if(options.InstancePage!=null&&options.InstanceEvidence==null)options.InstanceEvidence=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"instance-page-evidence.json");
                string eventName=options.QuitUi?"Local\\AiCreditGatewayQuitUi_":options.InstanceEvidence!=null?"Local\\AiCreditGatewayEvidence_":"Local\\AiCreditGatewayShow_";
                using(var signal=EventWaitHandle.OpenExisting(eventName+hash)) {
                    string nonce=null;
                    if(options.InstanceEvidence!=null) {
                        if(options.InstanceEvidence.StartsWith("\\\\",StringComparison.Ordinal))throw new ArgumentException();
                        nonce=Guid.NewGuid().ToString("N");Json.Save(ControlFile(options,hash),new{nonce=nonce,path=options.InstanceEvidence,issuedAt=DateTimeOffset.UtcNow.ToString("o"),page=options.InstancePage});
                    }
                    if(!options.Background||options.QuitUi||options.InstanceEvidence!=null)signal.Set();
                    if(options.InstanceEvidence!=null){var wait=Stopwatch.StartNew();while(wait.ElapsedMilliseconds<65000){if(File.Exists(options.InstanceEvidence))try{var result=Json.Object(File.ReadAllText(options.InstanceEvidence,Encoding.UTF8));if(Json.Text(result,"nonce")==nonce&&!Object.Equals(result.ContainsKey("pending")?result["pending"]:false,true))return Object.Equals(result["ok"],true)?0:1;}catch{}Thread.Sleep(120);}return 2;}
                }
                return 0;
            } catch { if(options.InstanceEvidence!=null)Json.Save(options.InstanceEvidence,new{ok=false,stage="resident-instance-unavailable",source="single-instance-control"});return options.QuitUi?0:2; }
        }
        private static void Post(MainForm form,Action action) {
            for(int i=0;i<100&&!form.IsHandleCreated&&!form.IsDisposed;i++)Thread.Sleep(30);
            try{if(form.IsHandleCreated&&!form.IsDisposed)form.BeginInvoke(action);}catch{}
        }
        private static async void EvidenceRequest(MainForm form,string file) {
            string output=null,nonce=null;
            try {
                if(!File.Exists(file)||new FileInfo(file).Length>8192)return;
                var request=Json.Object(File.ReadAllText(file,Encoding.UTF8));output=Json.Text(request,"path");nonce=Json.Text(request,"nonce");DateTimeOffset at;
                if(nonce.Length!=32||!nonce.All(Uri.IsHexDigit)||String.IsNullOrWhiteSpace(output)||output.Length>1024||!Path.IsPathRooted(output)||output.StartsWith("\\\\",StringComparison.Ordinal))return;
                string page=Json.Text(request,"page");if(page=="")page=null;else page=BridgePolicy.NormalizePage(page);
                if(request.Keys.Any(k=>k!="nonce"&&k!="path"&&k!="issuedAt"&&k!="page")||!DateTimeOffset.TryParse(Json.Text(request,"issuedAt"),out at)||Math.Abs((DateTimeOffset.UtcNow-at).TotalSeconds)>60){Json.Save(output,new{ok=false,nonce=nonce,stage="resident-evidence-request-expired-or-invalid"});return;}
                File.Delete(file);
                await form.WriteInstanceEvidence(output,nonce,page);
            }catch{if(output!=null&&nonce!=null)try{Json.Save(output,new{ok=false,nonce=nonce,stage="resident-evidence-failed"});}catch{}}
        }
        [STAThread] private static int Main(string[] args) {
            Options o = null;
            try {
                o = Options.Parse(args);
                try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                if (o.ContractTest != null) {
                    object contract = BridgePolicy.Contract(); Json.Save(o.ContractTest, contract);
                    return Convert.ToInt32(Json.Object(Json.Encode(contract))["failed"]) == 0 ? 0 : 1;
                }
                if(o.ToolsContractTest!=null){object report=BridgePolicy.ManagementContract();Json.Save(o.ToolsContractTest,report);return Convert.ToInt32(Json.Object(Json.Encode(report))["failed"])==0?0:1;}
                if(o.SelfTest!=null){using(var test=new MainForm(o)){Application.Run(test);return test.ResultCode;}}
                string hash=Identity(o.Config);bool first;
                using(var mutex=new Mutex(true,"Local\\AiCreditGatewayDesktop_"+hash,out first)) {
                    if(!first)return SignalExisting(o,hash);
                    try {
                        if(o.QuitUi)return 0;
                        if(o.InstanceEvidence!=null||o.InstancePage!=null){if(o.InstanceEvidence!=null)Json.Save(o.InstanceEvidence,new{ok=false,stage="no-running-instance",source="single-instance-control"});return 2;}
                        using(var show=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\AiCreditGatewayShow_"+hash))
                        using(var quit=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\AiCreditGatewayQuitUi_"+hash))
                        using(var evidence=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\AiCreditGatewayEvidence_"+hash))
                        using(var form=new MainForm(o)) {
                            var ws=ThreadPool.RegisterWaitForSingleObject(show,(s,t)=>Post(form,form.RestoreVisibleWindow),null,Timeout.Infinite,false);
                            var wq=ThreadPool.RegisterWaitForSingleObject(quit,(s,t)=>Post(form,form.RequestQuit),null,Timeout.Infinite,false);
                            var we=ThreadPool.RegisterWaitForSingleObject(evidence,(s,t)=>Post(form,()=>EvidenceRequest(form,ControlFile(o,hash))),null,Timeout.Infinite,false);
                            try{Application.Run(form);return form.ResultCode;}finally{ws.Unregister(null);wq.Unregister(null);we.Unregister(null);}
                        }
                    }finally{mutex.ReleaseMutex();}
                }
            } catch (Exception e) {
                if (o != null && o.SelfTest != null) Json.Save(o.SelfTest, new { ok = false, stage = "host-start", errorType = e.GetType().Name });
                return 1;
            }
        }
    }
}
