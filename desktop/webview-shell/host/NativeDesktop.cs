using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace AiCreditDesktop {
    internal static class Json {
        internal static readonly JavaScriptSerializer Codec = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        internal static Dictionary<string, object> Object(string text) { return Codec.Deserialize<Dictionary<string, object>>(text); }
        internal static string Text(object o) { return Codec.Serialize(o); }
        internal static string Get(IDictionary<string, object> o, string k, string fallback = "") { return o.ContainsKey(k) && o[k] != null ? Convert.ToString(o[k]) : fallback; }
        internal static string[] Strings(IDictionary<string, object> o, string k) {
            if (o == null || !o.ContainsKey(k) || o[k] == null || o[k] is string) return new string[0];
            var list = o[k] as System.Collections.IEnumerable; if (list == null) return new string[0];
            return list.Cast<object>().Select(Convert.ToString).Where(s => !string.IsNullOrEmpty(s)).Distinct().ToArray();
        }
        internal static bool Enabled(IDictionary<string, object> o) { return !o.ContainsKey("enabled") || !object.Equals(o["enabled"], false); }
        internal static IEnumerable<Dictionary<string, object>> Rows(IDictionary<string, object> o, string k) {
            if (!o.ContainsKey(k) || !(o[k] is System.Collections.IEnumerable)) return Enumerable.Empty<Dictionary<string, object>>();
            return ((System.Collections.IEnumerable)o[k]).Cast<object>().OfType<Dictionary<string, object>>();
        }
        internal static string Pretty(object value) {
            string s = Text(value); var b = new StringBuilder(); int depth = 0; bool quoted = false, escaped = false;
            foreach (char c in s) {
                if (quoted) { b.Append(c); if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') quoted = false; continue; }
                if (c == '"') { quoted = true; b.Append(c); }
                else if (c == '{' || c == '[') { b.Append(c); depth++; b.AppendLine(); b.Append(' ', depth * 2); }
                else if (c == '}' || c == ']') { depth--; b.AppendLine(); b.Append(' ', depth * 2); b.Append(c); }
                else if (c == ',') { b.Append(c); b.AppendLine(); b.Append(' ', depth * 2); }
                else if (c == ':') b.Append(": "); else b.Append(c);
            }
            return b.ToString();
        }
    }
    internal static class BrandAssets {
        internal static readonly Image Logo=LoadLogo();
        internal static readonly Icon AppIcon=LoadIcon();
        private static Image LoadLogo(){using(var stream=typeof(BrandAssets).Assembly.GetManifestResourceStream("AiCredit.BrandLogo.png")){if(stream==null)throw new InvalidOperationException("Brand logo resource missing");using(var image=Image.FromStream(stream))return BrandRaster.Render(image,256);}}
        private static Icon LoadIcon(){using(var stream=typeof(BrandAssets).Assembly.GetManifestResourceStream("AiCredit.BrandIcon.ico")){if(stream==null)throw new InvalidOperationException("Brand icon resource missing");using(var icon=new Icon(stream,new Size(32,32)))return (Icon)icon.Clone();}}
    }
    internal static class Theme {
        // 浅雾灰画布 / 白卡 / 深墨文字 / 蓝绿强调（DESIGN.md tokens，非单色替换）。
        internal static readonly Color Background=Color.FromArgb(243,246,247), Surface=Color.White, Ink=Color.FromArgb(22,37,45), Muted=Color.FromArgb(83,103,116), Accent=Color.FromArgb(17,123,133);
        internal static readonly Color Success=Color.FromArgb(15,122,86), Warning=Color.FromArgb(180,105,10), Danger=Color.FromArgb(186,42,42), Selection=Color.FromArgb(232,243,244), Soft=Color.FromArgb(246,249,250);
        internal static readonly Color AccentHover=Color.FromArgb(20,140,151), AccentPress=Color.FromArgb(12,95,103), Disabled=Color.FromArgb(238,242,243);
        internal static readonly Font Body=new Font("Microsoft YaHei UI",9.5F),Title=new Font("Microsoft YaHei UI",20F,FontStyle.Bold),Mono=new Font("Consolas",10F);
        internal const int Padding=20,Row=40,ButtonHeight=36;
        internal static Button Button(string title){return new StudioButton {Text=title,AutoSize=true,MinimumSize=new Size(100,ButtonHeight),FlatStyle=FlatStyle.Flat,BackColor=Surface,ForeColor=Ink,Margin=new Padding(0,0,10,8),Padding=new Padding(8,2,8,2)};}
        internal static TextBox Output(){return new TextBox {Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,WordWrap=false,Dock=DockStyle.Fill,Font=Mono,BackColor=Surface,ForeColor=Ink,BorderStyle=BorderStyle.None};}
        internal static DataGridView Grid(params string[] columns){var g=new DataGridView {Font=Body,Dock=DockStyle.Fill,ReadOnly=true,AllowUserToAddRows=false,AllowUserToDeleteRows=false,AllowUserToResizeRows=false,MultiSelect=false,SelectionMode=DataGridViewSelectionMode.FullRowSelect,AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill,BackgroundColor=Surface,BorderStyle=BorderStyle.None,RowHeadersVisible=false,EnableHeadersVisualStyles=false};
            g.ColumnHeadersDefaultCellStyle=new DataGridViewCellStyle {BackColor=Soft,ForeColor=Color.FromArgb(82,82,82),Font=new Font(Body,FontStyle.Bold),Padding=new Padding(8)};
            g.DefaultCellStyle=new DataGridViewCellStyle {BackColor=Surface,ForeColor=Ink,SelectionBackColor=Selection,SelectionForeColor=Ink,Padding=new Padding(8,4,8,4)};
            g.ShowCellErrors=false;g.ShowRowErrors=false;g.StandardTab=true;g.ColumnHeadersHeightSizeMode=DataGridViewColumnHeadersHeightSizeMode.DisableResizing;g.CellBorderStyle=DataGridViewCellBorderStyle.SingleHorizontal;g.GridColor=Color.FromArgb(235,235,235);g.ColumnHeadersBorderStyle=DataGridViewHeaderBorderStyle.None;g.AlternatingRowsDefaultCellStyle.BackColor=Color.FromArgb(250,250,250);g.RowTemplate.Height=Row;g.ColumnHeadersHeight=Row+8;foreach(string c in columns)g.Columns.Add(c,c);return g;}
    }
    internal sealed class Gateway : IDisposable {
        internal readonly string Root, ConfigFile, Node, Entry;
        internal string BaseUrl;
        private HttpClient client;
        internal Gateway(string configOverride) {
            Root = AppDomain.CurrentDomain.BaseDirectory; Node = Path.Combine(Root, "runtime", "node.exe"); Entry = Path.Combine(Root, "core", "bin", "ai-credit.mjs");
            string config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AiCreditGateway", "config.local.json");
            string local = Path.Combine(Root, "desktop.local.json");
            if (File.Exists(local)) config = Json.Get(Json.Object(File.ReadAllText(local, Encoding.UTF8)), "configFile", config);
            ConfigFile = Path.GetFullPath(string.IsNullOrEmpty(configOverride) ? config : configOverride);
        }
        internal async Task<string> Command(string command) {
            var p = new Process { StartInfo = new ProcessStartInfo(Node, "\"" + Entry + "\" " + command + " --config \"" + ConfigFile + "\"") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 } };
            p.Start(); var stdout = p.StandardOutput.ReadToEndAsync(); var stderr = p.StandardError.ReadToEndAsync();
            bool exited = await Task.Run(() => p.WaitForExit(30000));
            if (!exited) { try { p.Kill(); } catch { } p.Dispose(); throw new Exception("后台启动超时，请检查配置和本机日志。"); }
            string result = await stdout; await stderr; int exit = p.ExitCode; p.Dispose();
            if (exit != 0) throw new Exception("后台命令失败：" + command + "；退出码 " + exit + "。请检查本机配置。");
            return result;
        }
        private readonly SemaphoreSlim connectionGate = new SemaphoreSlim(1,1);
        private readonly List<HttpClient> retiredClients = new List<HttpClient>();
        private string connectionIdentity;
        internal async Task Connect(bool start) {
            await connectionGate.WaitAsync();
            try {
                if (!File.Exists(ConfigFile)) { Directory.CreateDirectory(Path.GetDirectoryName(ConfigFile)); await Command("init"); }
                if (start) await Command("start");
                var config = Json.Object(File.ReadAllText(ConfigFile, Encoding.UTF8));
                string data = Json.Get(config, "dataDir", "./data"); if (!Path.IsPathRooted(data)) data = Path.Combine(Path.GetDirectoryName(ConfigFile), data);
                var runtime = Json.Object(File.ReadAllText(Path.Combine(data, "runtime.json"), Encoding.UTF8));
                string address = Json.Get(runtime, "baseUrl"); Uri url;
                if (!Uri.TryCreate(address, UriKind.Absolute, out url) || url.Scheme != "http" || !url.IsLoopback || !string.IsNullOrEmpty(url.UserInfo) || url.AbsolutePath != "/" || !string.IsNullOrEmpty(url.Query)) throw new Exception("后台地址不是有效的本机回环地址。");
                var keys = Json.Object(File.ReadAllText(Path.Combine(data, "api-keys.json"), Encoding.UTF8));
                string key = Json.Get(keys,"adminKey"), identity;
                using(var sha=SHA256.Create()) identity=address+Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(key)));
                if(client==null || identity!=connectionIdentity) {
                    var next = new HttpClient(new HttpClientHandler { UseProxy=false, AllowAutoRedirect=false });
                    next.BaseAddress=url; next.Timeout=Timeout.InfiniteTimeSpan;
                    next.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",key);
                    // Requests capture their own client. Rebinding never disposes an in-flight request.
                    if(client!=null)retiredClients.Add(client); client=next; connectionIdentity=identity;
                }
                BaseUrl=address;
                var health=await Send(client,"GET","/health",null,5);
                if(Json.Get(health,"service")!="ai-credit-gateway")throw new Exception("端口上运行的不是积分网关服务。");
            } finally { connectionGate.Release(); }
        }
        private static async Task<Dictionary<string,object>> Send(HttpClient connection,string method,string path,object body,int seconds,CancellationToken cancellation=default(CancellationToken)) {
            using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using(var req=new HttpRequestMessage(new HttpMethod(method),path)) {
                timeout.CancelAfter(TimeSpan.FromSeconds(seconds));
                if(body!=null)req.Content=new StringContent(Json.Text(body),Encoding.UTF8,"application/json");
                using(var res=await connection.SendAsync(req,timeout.Token)) {
                    var value=Json.Object(await res.Content.ReadAsStringAsync());
                    if(!res.IsSuccessStatusCode) {
                        var error=value.ContainsKey("error")?value["error"] as Dictionary<string,object>:null;
                        var failure=new InvalidOperationException(error==null?"本机接口返回 HTTP "+(int)res.StatusCode:Json.Get(error,"message"));failure.Data["httpStatus"]=(int)res.StatusCode;throw failure;
                    }
                    return value;
                }
            }
        }
        // Jobs submit once; polling is explicitly read-only. A closed window cancels only its own wait.
        internal Task<Dictionary<string,object>> TaskRequest(string method,string path,object body,CancellationToken cancellation) {
            var connection=client;if(connection==null)throw new InvalidOperationException("请先启动后台服务。");
            return Send(connection,method,path,body,8,cancellation);
        }
        internal async Task<Dictionary<string,object>> Request(string method,string path,object body=null) {
            var connection=client;if(connection==null)throw new Exception("请先启动后台服务。");
            int seconds=method=="GET"?45:path.Contains("/tasks")||path.Contains("/sessions/merge")?300:90;
            try { return await Send(connection,method,path,body,seconds); }
            catch(Exception e) {
                // Only transport-failed reads are replayable. Never resubmit a claim, switch or delete.
                if(method!="GET" || !(e is HttpRequestException || e is TaskCanceledException))throw;
                // Retry below, outside catch for the .NET Framework C# compiler.
            }
            await Connect(false); return await Send(client,method,path,body,seconds);

        }
        public void Dispose() { if(client!=null)client.Dispose();foreach(var old in retiredClients)old.Dispose();connectionGate.Dispose(); }

    }


    internal static class UiMetrics {
        internal const int Sidebar=232, Header=96, Footer=52, CardHeight=320, CardGap=14, CardMinWidth=300, Radius=14, Inset=24;
        internal static readonly Color Rail=Color.FromArgb(255,255,255), RailHover=Color.FromArgb(237,243,244), Line=Color.FromArgb(220,229,232), Good=Theme.Success;
        // 现代极简：平台色收敛为克制的指示小圆点色（仅作来源标识，不作状态）。
        internal static readonly Color InkSoft=Color.FromArgb(74,96,107);
        internal static Color Mix(Color a,Color b,float t){t=Math.Max(0,Math.Min(1,t));return Color.FromArgb((int)(a.R+(b.R-a.R)*t),(int)(a.G+(b.G-a.G)*t),(int)(a.B+(b.B-a.B)*t));}
        // 现代卡片：白底 + 1px 细边框 + 极软下阴影（克制，不堆砌）。
        internal static void Card(Graphics g,RectangleF r,float radius){using(var p=Round(r,radius)){var sh=r;sh.Offset(0,1);using(var sb=new SolidBrush(Color.FromArgb(14,15,23,25)))using(var sp=Round(sh,radius))g.FillPath(sb,sp);using(var b=new SolidBrush(Theme.Surface))g.FillPath(b,p);using(var pen=new Pen(Line,1))g.DrawPath(pen,p);}}
        internal static void Elevation(Graphics g,RectangleF r,float radius){var sh=r;sh.Offset(0,1);using(var sb=new SolidBrush(Color.FromArgb(10,15,23,20)))using(var sp=Round(sh,radius))g.FillPath(sb,sp);}
        // 强调色浅底（图标/KPI 用）。
        internal static readonly Color AccentSoft=Color.FromArgb(228,242,243), AccentMid=Color.FromArgb(168,208,212);
        internal static Color PlatformColor(string platform){return platform=="workbuddy"?Color.FromArgb(22,163,74):platform=="qwenwork"?Color.FromArgb(126,58,242):platform=="trae"?Color.FromArgb(37,99,235):platform=="minimax"?Color.FromArgb(8,145,178):platform=="nvidia"?Color.FromArgb(92,153,0):platform=="bigmodel"?Color.FromArgb(79,70,229):PlatformPresentation.ColorFor(platform);}
        internal static float Scale(Control c) { using(var g=c.CreateGraphics())return g.DpiX/96f; }
        internal static GraphicsPath Round(RectangleF r,float radius) { var p=new GraphicsPath();float d=Math.Min(radius*2,Math.Min(r.Width,r.Height));if(d<=0)return p;p.AddArc(r.X,r.Y,d,d,180,90);p.AddArc(r.Right-d,r.Y,d,d,270,90);p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.X,r.Bottom-d,d,d,90,90);p.CloseFigure();return p; }
        internal static void Box(Graphics g,RectangleF r,Color color,float radius=12) { using(var p=Round(r,radius))using(var b=new SolidBrush(color))g.FillPath(b,p); }
        internal static void Text(Graphics g,string text,float size,Color color,RectangleF rect,bool bold=false,string family="Microsoft YaHei UI",StringAlignment alignment=StringAlignment.Near) {
            using(var font=new Font(family,size,bold?FontStyle.Bold:FontStyle.Regular,GraphicsUnit.Pixel))using(var brush=new SolidBrush(color))using(var f=new StringFormat { Alignment=alignment,LineAlignment=StringAlignment.Center,Trimming=StringTrimming.EllipsisCharacter })g.DrawString(text,font,brush,rect,f);
        }
        internal static void Icon(Graphics g,int kind,float x,float y,Color color) {
            using(var p=new Pen(color,1.7f)) { p.StartCap=LineCap.Round;p.EndCap=LineCap.Round;
                if(kind==0){foreach(var dx in new[]{0f,10f})foreach(var dy in new[]{0f,10f})g.DrawRectangle(p,x+dx,y+dy,6,6);}
                else if(kind==1){g.DrawEllipse(p,x+5,y,7,7);g.DrawArc(p,x+1,y+10,15,10,180,180);}
                else if(kind==2){g.DrawEllipse(p,x,y+5,5,5);g.DrawEllipse(p,x+12,y,5,5);g.DrawEllipse(p,x+12,y+12,5,5);g.DrawLine(p,x+5,y+7,x+12,y+3);g.DrawLine(p,x+5,y+8,x+12,y+14);}
                else if(kind==3){g.DrawRectangle(p,x+2,y,13,18);for(int i=5;i<15;i+=4)g.DrawLine(p,x+5,y+i,x+12,y+i);}
                else if(kind==5){g.DrawLine(p,x,y+18,x+18,y+18);g.DrawLine(p,x+3,y+14,x+3,y+8);g.DrawLine(p,x+9,y+14,x+9,y+2);g.DrawLine(p,x+15,y+14,x+15,y+5);}
                else {g.DrawEllipse(p,x+1,y+1,15,15);g.DrawEllipse(p,x+6,y+6,5,5);for(int i=0;i<4;i++){var t=(float)(i*Math.PI/2);g.DrawLine(p,x+8+(float)Math.Cos(t)*7,y+8+(float)Math.Sin(t)*7,x+8+(float)Math.Cos(t)*10,y+8+(float)Math.Sin(t)*10);}}
            }
        }
    }
    // 减少动画偏好：读取 Windows 客户端区域动画开关；MotionPolicy.Enabled 供内部测试强制关闭。
    internal static class MotionPolicy {
        [DllImport("user32.dll")] private static extern bool SystemParametersInfo(int action,int param,ref int value,int flags);
        private const int GetClientAreaAnimation=0x1042;
        internal static bool Enabled=true;
        private static bool? allowed;
        internal static void Reset(){allowed=null;}
        internal static bool Reduced {get{ if(!allowed.HasValue){allowed=ClientAreaAnimationAllowed();}return !allowed.Value; }}
        internal static bool Active {get{return Enabled&&!Reduced;}}
        // 供内部测试：读取系统减少动画偏好，同时给出 SPI 是否可用。
        internal static bool ClientAreaAnimationAllowed(){int flag=1;try{return SystemParametersInfo(GetClientAreaAnimation,0,ref flag,0)&&flag!=0;}catch(Exception){return SystemInformation.IsMenuAnimationEnabled;}}
    }
    // 共享 16ms 心跳：全部界面动效共用一个定时器，订阅为空自动停止，隐藏/后台可整体挂起。
    internal static class MotionClock {
        private static readonly List<Action> subscribers=new List<Action>();
        private static readonly System.Windows.Forms.Timer clock=new System.Windows.Forms.Timer {Interval=16};
        private static bool suspended;
        static MotionClock(){clock.Tick+=(s,e)=>Pump();}
        internal static int SubscriberCount {get{return subscribers.Count;}}
        internal static bool Running {get{return clock.Enabled;}}
        internal static bool Suspended {get{return suspended;}set{suspended=value;if(value)Stop();else if(subscribers.Count>0)Start();}}
        internal static void Subscribe(Action tick){if(tick==null)return;if(!subscribers.Contains(tick))subscribers.Add(tick);Start();}
        internal static void Unsubscribe(Action tick){if(tick==null)return;subscribers.Remove(tick);if(subscribers.Count==0)Stop();}
        private static void Start(){if(suspended||subscribers.Count==0)return;if(!clock.Enabled)clock.Start();}
        private static void Stop(){if(clock.Enabled)clock.Stop();}
        private static void Pump(){if(subscribers.Count==0){Stop();return;}var snapshot=subscribers.ToArray();for(int i=0;i<snapshot.Length;i++){try{snapshot[i]();}catch(ObjectDisposedException){subscribers.Remove(snapshot[i]);}}if(subscribers.Count==0)Stop();}
    }
    // 平台图标：优先同目录 platform-icons/<platform>.png（主控从本机快捷方式提取），回退既有可执行文件图标，最后回退字母占位。
    internal static class PlatformLogoCache {
        private static readonly Dictionary<string,Image> cache=new Dictionary<string,Image>();
        internal static string Folder {get{return Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"platform-icons");}}
        internal static Image Get(string platform){
            if(string.IsNullOrEmpty(platform))return null;
            Image cached;if(cache.TryGetValue(platform,out cached))return cached;
            Image image=FromFolder(platform);if(image==null)image=FromExecutable(platform);
            cache[platform]=image;return image;
        }
        private static Image FromFolder(string platform){
            try{string file=Path.Combine(Folder,platform+".png");if(!File.Exists(file))return null;using(var stream=File.OpenRead(file))using(var source=Image.FromStream(stream))return new Bitmap(source,new Size(64,64));}catch(Exception){return null;}
        }
        private static Image FromExecutable(string platform){
            string path=platform=="workbuddy"?@"D:\workbuddy\WorkBuddy.exe":platform=="trae"?@"D:\Trae CN\Trae.exe":platform=="qwenwork"?@"D:\QwenWorkCN\1.2.5-26092902\QwenWorkCN.exe":platform=="minimax"?@"D:\MiniMax Code\MiniMax Code.exe":platform=="zcode"?@"D:\zcode\ZCode.exe":null;
            if(path==null)return null;
            try{if(!File.Exists(path))return null;using(var icon=Icon.ExtractAssociatedIcon(path))return icon==null?null:icon.ToBitmap();}catch(Exception){return null;}
        }
    }
    // 概览滚动容器：禁止把控件自动滚入视野（focus / 添加控件都会触发），滚动位置只由锚点恢复与用户输入决定。
    internal sealed class OverviewScrollPanel : Panel {
        internal event EventHandler ScrollMoved;
        internal OverviewScrollPanel(){DoubleBuffered=true;AutoScroll=true;}
        protected override Point ScrollToControl(Control activeControl){return DisplayRectangle.Location;}
        protected override void OnScroll(ScrollEventArgs se){base.OnScroll(se);if(ScrollMoved!=null)ScrollMoved(this,EventArgs.Empty);}
    }
    internal struct ScrollAnchor { internal string Id; internal int Offset; internal bool Known{get{return !string.IsNullOrEmpty(Id);}} }
    internal sealed class StudioButton : Button {
        internal bool Navigation,Selected;internal int Glyph;private bool hover,pressed;private float hoverLevel,pressLevel,focusLevel;private readonly Action motionTick;
        internal bool MotionActive {get{return motionSubscribed;}}
        private bool motionSubscribed;
        internal StudioButton(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;Cursor=Cursors.Hand;motionTick=()=>{float hoverTarget=hover&&Enabled?1:0;hoverLevel+=(hoverTarget-hoverLevel)*.3f;float pressTarget=pressed&&Enabled?1:0;pressLevel+=(pressTarget-pressLevel)*.45f;float focusTarget=Focused?1:0;focusLevel+=(focusTarget-focusLevel)*.3f;bool settled=Math.Abs(hoverTarget-hoverLevel)<.012f&&Math.Abs(pressTarget-pressLevel)<.012f&&Math.Abs(focusTarget-focusLevel)<.012f;if(settled){hoverLevel=hoverTarget;pressLevel=pressTarget;focusLevel=focusTarget;StopMotion();}Invalidate();};}
        private void StartMotion(){if(!MotionPolicy.Active){hoverLevel=hover?1:0;pressLevel=pressed?1:0;focusLevel=Focused?1:0;Invalidate();return;}if(!motionSubscribed){motionSubscribed=true;MotionClock.Subscribe(motionTick);}}
        private void StopMotion(){if(motionSubscribed){motionSubscribed=false;MotionClock.Unsubscribe(motionTick);}}
        internal void SnapMotion(){StopMotion();hoverLevel=hover?1:0;pressLevel=pressed?1:0;focusLevel=Focused?1:0;Invalidate();}
        protected override void OnMouseEnter(EventArgs e){hover=true;StartMotion();base.OnMouseEnter(e);}protected override void OnMouseLeave(EventArgs e){hover=false;pressed=false;StartMotion();base.OnMouseLeave(e);}
        protected override void OnMouseDown(MouseEventArgs e){pressed=true;StartMotion();base.OnMouseDown(e);}protected override void OnMouseUp(MouseEventArgs e){pressed=false;StartMotion();base.OnMouseUp(e);}
        protected override void OnGotFocus(EventArgs e){base.OnGotFocus(e);StartMotion();}protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);StartMotion();}
        protected override void OnEnabledChanged(EventArgs e){base.OnEnabledChanged(e);SnapMotion();}
        internal void ExerciseHover(){OnMouseEnter(EventArgs.Empty);OnMouseLeave(EventArgs.Empty);}
        protected override void OnPaint(PaintEventArgs e){if(ClientSize.Width<=2||ClientSize.Height<=2)return;var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;if(Parent!=null&&Parent.BackColor.A<255){Control surface=Parent;int ox=Left,oy=Top;while(surface.Parent!=null&&surface.BackColor.A<255){ox+=surface.Left;oy+=surface.Top;surface=surface.Parent;}var state=g.Save();g.TranslateTransform(-ox,-oy);var args=new PaintEventArgs(g,new Rectangle(ox,oy,Width,Height));InvokePaintBackground(surface,args);InvokePaint(surface,args);g.Restore(state);}else g.Clear(Parent==null?Theme.Background:Parent.BackColor);float scale=g.DpiX/96f;g.ScaleTransform(scale,scale);float w=Width/scale,h=Height/scale;bool primary=BackColor==Theme.Accent;
            Color normal=Navigation?(Selected?UiMetrics.AccentSoft:UiMetrics.Rail):BackColor;Color over=Navigation?(Selected?UiMetrics.AccentSoft:UiMetrics.RailHover):(primary?Theme.AccentHover:Theme.Soft);Color fill=UiMetrics.Mix(normal,over,hoverLevel);
            if(primary)fill=UiMetrics.Mix(fill,Theme.AccentPress,pressLevel);if(pressed)fill=Navigation?(Selected?UiMetrics.AccentMid:UiMetrics.RailHover):(primary?UiMetrics.Mix(Theme.AccentPress,Color.Black,.18f):UiMetrics.AccentSoft);if(!Enabled)fill=Navigation?normal:Theme.Disabled;
            var rect=new RectangleF(1,1,w-2,h-2);UiMetrics.Box(g,rect,fill,10);
            Color ink=Navigation?(Selected?Theme.Accent:UiMetrics.InkSoft):(Enabled?(primary?Color.White:Theme.Ink):Color.FromArgb(159,175,182));
            if(!Navigation&&!primary){using(var pen=new Pen(Enabled?UiMetrics.Mix(UiMetrics.Line,UiMetrics.AccentMid,hoverLevel):UiMetrics.Line,1))using(var p=UiMetrics.Round(rect,10))g.DrawPath(pen,p);}
            if(Navigation){if(Selected)UiMetrics.Box(g,new RectangleF(0,10,3,h-20),Theme.Accent,1.5f);UiMetrics.Icon(g,Glyph,14,(h-18)/2,ink);UiMetrics.Text(g,Text,13,ink,new RectangleF(44,0,w-50,h),Selected);}
            else UiMetrics.Text(g,Text,12,ink,new RectangleF(8,0.5f+pressLevel,w-16,h),primary,"Microsoft YaHei UI",StringAlignment.Center);
            if(focusLevel>0.02f)using(var pen=new Pen(Navigation?(Selected?Theme.Accent:UiMetrics.InkSoft):(primary?Color.White:Theme.Accent),1.5f)){pen.DashStyle=DashStyle.Dot;using(var p=UiMetrics.Round(new RectangleF(4,4,w-8,h-8),7))g.DrawPath(pen,p);}
        }
        protected override void Dispose(bool disposing){if(disposing)StopMotion();base.Dispose(disposing);}
    }
    // 一个生命周期拥有者负责容器快照、进入/退出与资源释放；子控件随容器整体参与过渡。
    internal sealed class SurfaceTransition : IDisposable {
        private readonly Control host;private readonly SnapshotOverlay overlay;private readonly Action tick;private Action completed;private Form exiting;private float progress;private bool active;
        internal SurfaceTransition(Control host){this.host=host;overlay=new SnapshotOverlay {Visible=false};host.Controls.Add(overlay);tick=()=>Advance(.09f);}
        internal bool Active {get{return active;}}internal bool HasSnapshot {get{return overlay.Snapshot!=null;}}
        internal bool Capture(Control source){Cancel();if(!MotionPolicy.Active||MotionClock.Suspended||!host.Visible)return false;overlay.Bounds=source==host?host.ClientRectangle:source.Bounds;return overlay.CaptureFrame(source);}
        internal void Play(Control destination,Action done=null){completed=done;if(overlay.Snapshot==null||!MotionPolicy.Active){Finish();return;}overlay.CaptureDestination(destination);overlay.Level=1f;overlay.Visible=true;overlay.BringToFront();progress=0;active=true;MotionClock.Subscribe(tick);}
        internal void Exit(Form form,Action done){if(!Capture(form)){done();return;}exiting=form;Play(null,done);}
        internal void Advance(float amount){if(!active)return;progress=Math.Min(1f,progress+amount);overlay.Level=1f-progress;if(exiting!=null&&!exiting.IsDisposed)exiting.Opacity=1f-progress*.9f;if(progress>=1f)Finish();}
        private void Finish(){var done=completed;completed=null;Cancel();if(done!=null)done();}
        internal void Cancel(){MotionClock.Unsubscribe(tick);active=false;overlay.Visible=false;overlay.Release();if(exiting!=null&&!exiting.IsDisposed)exiting.Opacity=1;exiting=null;completed=null;}
        public void Dispose(){Cancel();overlay.Dispose();}
    }
    internal sealed class PageDeck : Panel {
        internal readonly List<Panel> Panels=new List<Panel>();private int selected;private readonly SurfaceTransition transition;
        internal event EventHandler SelectedIndexChanged;
        internal PageDeck(){DoubleBuffered=true;transition=new SurfaceTransition(this);}
        internal SurfaceTransition Transition {get{return transition;}}
        internal void AddPage(Panel page){Panels.Add(page);page.Dock=DockStyle.Fill;Controls.Add(page);page.Visible=Panels.Count-1==selected;}
        // Visibility is switched before the transition runs. When the snapshot
        // capture threw, the old code left every page visible, so a page that had
        // crashed stayed painted underneath the newly selected one.
        internal int SelectedIndex {get{return selected;}set{if(value<0||value>=Panels.Count)return;bool changed=selected!=value;if(changed){try{transition.Capture(Panels[selected]);}catch{}}selected=value;for(int i=0;i<Panels.Count;i++)Panels[i].Visible=i==value;Panels[value].BringToFront();if(changed){try{transition.Play(Panels[value]);}catch{}}if(SelectedIndexChanged!=null)SelectedIndexChanged(this,EventArgs.Empty);}}
        protected override void Dispose(bool disposing){if(disposing)transition.Dispose();base.Dispose(disposing);}
    }
    internal sealed class SnapshotOverlay : Panel {
        private Bitmap bitmap,destination;private float level=1f;
        internal SnapshotOverlay(){SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);}
        // 叠层只做绘制：命中测试返回 HTTRANSPARENT，淡出期间下层照常可点击。
        protected override void WndProc(ref Message m){if(m.Msg==0x84){m.Result=new IntPtr(-1);return;}base.WndProc(ref m);}
        internal float Level {get{return level;}set{level=value;Invalidate();}}
        internal bool CaptureFrame(Control source){Release();try{if(source==null||source.Width<=2||source.Height<=2)return false;var shot=new Bitmap(source.Width,source.Height);source.DrawToBitmap(shot,new Rectangle(0,0,source.Width,source.Height));bitmap=shot;return true;}catch(Exception){return false;}}
        internal bool CaptureDestination(Control source){if(destination!=null){destination.Dispose();destination=null;}try{if(source==null)return false;destination=new Bitmap(source.Width,source.Height);source.DrawToBitmap(destination,new Rectangle(Point.Empty,source.Size));return true;}catch(Exception){if(destination!=null)destination.Dispose();destination=null;return false;}}
        internal Bitmap Snapshot {get{return bitmap;}}
        internal void Release(){if(bitmap!=null){bitmap.Dispose();bitmap=null;}if(destination!=null){destination.Dispose();destination=null;}}
        protected override void OnPaint(PaintEventArgs e){if(bitmap==null)return;var g=e.Graphics;g.Clear(Theme.Background);if(destination!=null)g.DrawImage(destination,ClientRectangle);g.SmoothingMode=SmoothingMode.AntiAlias;using(var attributes=new ImageAttributes()){float alpha=Math.Max(0f,Math.Min(1f,level));var matrix=new ColorMatrix(new float[][]{new float[]{1,0,0,0,0},new float[]{0,1,0,0,0},new float[]{0,0,1,0,0},new float[]{0,0,0,alpha,0},new float[]{0,0,0,0,1}});attributes.SetColorMatrix(matrix,ColorMatrixFlag.Default,ColorAdjustType.Bitmap);g.DrawImage(bitmap,new Rectangle(0,0,ClientSize.Width,ClientSize.Height),0,0,bitmap.Width,bitmap.Height,GraphicsUnit.Pixel,attributes);}}
    }
    internal sealed class RailPanel : Panel {
        internal RailPanel(){DoubleBuffered=true;BackColor=UiMetrics.Rail;}
        protected override void OnPaint(PaintEventArgs e){if(ClientSize.Width<=2||ClientSize.Height<=2)return;base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;float s=g.DpiX/96f;g.ScaleTransform(s,s);float w=Width/s,h=Height/s;
            g.Clear(Theme.Surface);
            g.DrawImage(BrandAssets.Logo,new RectangleF(20,21,40,40));
            UiMetrics.Text(g,"AI网关",16,Theme.Ink,new RectangleF(70,23,138,26),true);UiMetrics.Text(g,"本地工作台",11,Theme.Muted,new RectangleF(70,48,138,20));
            using(var pen=new Pen(UiMetrics.Line))g.DrawLine(pen,22,86,w-22,86);
            UiMetrics.Box(g,new RectangleF(18,h-78,w-36,58),UiMetrics.AccentSoft,12);UiMetrics.Text(g,"凭据保存在本机",11,Theme.Ink,new RectangleF(30,h-72,w-60,24),true);UiMetrics.Text(g,"现代控制台 · 原生桌面",10,Theme.Muted,new RectangleF(30,h-48,w-60,20));
            using(var pen=new Pen(UiMetrics.Line))g.DrawLine(pen,w-1,0,w-1,h);
        }
    }
    internal sealed class WorkbenchHeader : Panel {
        internal WorkbenchHeader(){DoubleBuffered=true;BackColor=Theme.Surface;}
        protected override void OnPaint(PaintEventArgs e){if(ClientSize.Width<=2||ClientSize.Height<=2)return;base.OnPaint(e);var g=e.Graphics;g.Clear(Theme.Surface);using(var pen=new Pen(UiMetrics.Line))g.DrawLine(pen,0,Height-1,Width,Height-1);}
    }
    internal sealed class DashboardHeader : Control {
        internal int Platforms,Verified,Routes;internal string Schedule="正在连接后台";
        private Dictionary<string,object>[] enabledAccounts=new Dictionary<string,object>[0];
        internal Dictionary<string,object>[] History=new Dictionary<string,object>[0];
        internal Dictionary<string,object>[] EnabledAccounts {get{return enabledAccounts;}set{enabledAccounts=value??new Dictionary<string,object>[0];AccessibleDescription="启用账号总数 "+enabledAccounts.Length+"；完整平台构成："+string.Join("；",enabledAccounts.GroupBy(x=>Json.Get(x,"platform")).Select(g=>PlatformPresentation.Name(g.Key)+" "+g.Count()+" 个账号"))+"。完整账号明细见账号管理。";}}
        internal KeyValuePair<string,int>[] AccountLegendRows(){var groups=EnabledAccounts.GroupBy(x=>Json.Get(x,"platform")).ToArray();if(groups.Length<=6)return groups.Select(g=>new KeyValuePair<string,int>(PlatformPresentation.Name(g.Key),g.Count())).ToArray();var rows=groups.Take(5).Select(g=>new KeyValuePair<string,int>(PlatformPresentation.Name(g.Key),g.Count())).ToList();rows.Add(new KeyValuePair<string,int>("其余 "+(groups.Length-5)+" 类",groups.Skip(5).Sum(g=>g.Count())));return rows.ToArray();}
        internal static RectangleF WideAccountBounds(float w){float right=Math.Max(292,w*.31f),left=w-right-14;return new RectangleF(left+14,1,right-3,216);}
        internal RectangleF[] AccountLegendTextRects(RectangleF card){return AccountLegendRows().Select((row,i)=>new RectangleF(card.X+171,69+i*23,card.Width-180,22)).ToArray();}
        internal DashboardHeader(){DoubleBuffered=true;BackColor=Theme.Background;Height=344;AccessibleRole=AccessibleRole.Chart;AccessibleName="领取趋势和已启用账号构成";}
        internal bool CompactLayout {get{return Width/UiMetrics.Scale(this)<820;}}
        protected override void OnResize(EventArgs e){base.OnResize(e);int desired=(int)((CompactLayout?640:344)*UiMetrics.Scale(this));if(Height!=desired)Height=desired;Invalidate();}
        internal static RectangleF[] CompactTextRegions(float w){float cw=(w-17)/2;var list=new List<RectangleF>{new RectangleF(20,13,w-40,28),new RectangleF(20,62,185,20)};for(int i=0;i<4;i++){float x=1+(i%2)*(cw+14),y=438+(i/2)*87;list.Add(new RectangleF(x+40,y+6,cw-56,20));list.Add(new RectangleF(x+18,y+30,cw-36,38));}return list.ToArray();}
        private void PaintCompact(Graphics g,float w){float gap=14;UiMetrics.Card(g,new RectangleF(1,1,w-3,222),12);UiMetrics.Text(g,"领取趋势",16,Theme.Ink,new RectangleF(20,13,w-40,28),true);UiMetrics.Text(g,"最近 100 条记录 · 近 7 天 · 次数 / 非积分",10,Pale,new RectangleF(20,42,w-40,18));UiMetrics.Box(g,new RectangleF(20,69,7,7),Cyan,4);UiMetrics.Text(g,"完成 / 已领",10,Pale,new RectangleF(33,62,85,20));UiMetrics.Box(g,new RectangleF(134,69,7,7),Violet,4);UiMetrics.Text(g,"其他",10,Pale,new RectangleF(147,62,60,20));
            int[] ok=DailyCounts(true),other=DailyCounts(false);int max=Math.Max(4,ok.Concat(other).Max());max=(int)(Math.Ceiling(max/4.0)*4);var plot=new RectangleF(43,97,w-70,84);for(int i=0;i<=4;i++){float y=plot.Y+plot.Height*i/4;using(var pen=new Pen(UiMetrics.Line))g.DrawLine(pen,plot.X,y,plot.Right,y);UiMetrics.Text(g,(max-max*i/4).ToString(),9,Pale,new RectangleF(8,y-7,27,15),false,"Segoe UI",StringAlignment.Far);}Series(g,plot,other,max,Violet);Series(g,plot,ok,max,Cyan);for(int i=0;i<7;i+=2)UiMetrics.Text(g,DateTime.Today.AddDays(i-6).ToString("MM-dd"),9,Pale,new RectangleF(plot.X+plot.Width*i/6-20,188,40,18),false,"Segoe UI",StringAlignment.Center);if(History.Length==0)UiMetrics.Text(g,"暂无领取记录",12,Pale,new RectangleF(plot.X,125,plot.Width,24),false,"Microsoft YaHei UI",StringAlignment.Center);
            UiMetrics.Card(g,new RectangleF(1,237,w-3,187),12);UiMetrics.Text(g,"账号构成",16,Theme.Ink,new RectangleF(20,249,w-40,28),true);UiMetrics.Text(g,"仅统计启用账号 · 不合计不同平台额度",10,Pale,new RectangleF(20,281,w-40,20));UiMetrics.Text(g,EnabledAccounts.Length.ToString(),34,Theme.Ink,new RectangleF(20,317,87,42),true,"Segoe UI");UiMetrics.Text(g,"启用账号",10,Pale,new RectangleF(20,361,87,20));var groups=EnabledAccounts.GroupBy(x=>Json.Get(x,"platform")).ToArray();for(int i=0;i<Math.Min(8,groups.Length);i++){float x=123+(i%2)*(w-150)/2,y=309+(i/2)*23;UiMetrics.Text(g,PlatformPresentation.Name(groups[i].Key)+"  "+groups[i].Count(),10,Pale,new RectangleF(x,y,(w-156)/2,20));}if(groups.Length>8)UiMetrics.Text(g,"另 "+(groups.Length-8)+" 类平台 · 详见账号管理",9,Pale,new RectangleF(123,401,w-148,18));
            string[] labels={"启用账号","余额核验","已启用模型","记录样本"};string[] values={EnabledAccounts.Length.ToString(),Verified+" / "+Platforms,Routes.ToString(),History.Length.ToString()};float cw=(w-gap-3)/2;for(int i=0;i<4;i++){float x=1+(i%2)*(cw+gap),y=438+(i/2)*87;UiMetrics.Card(g,new RectangleF(x,y,cw,73),12);UiMetrics.Icon(g,i,x+18,y+12,Theme.Ink);UiMetrics.Text(g,labels[i],11,Pale,new RectangleF(x+40,y+6,cw-56,20));UiMetrics.Text(g,values[i],26,Theme.Ink,new RectangleF(x+18,y+30,cw-36,38),true,"Segoe UI");}UiMetrics.Text(g,"平台余额",16,Theme.Ink,new RectangleF(3,610,145,24),true);UiMetrics.Text(g,Schedule,10,Theme.Muted,new RectangleF(151,610,w-156,24),false,"Microsoft YaHei UI",StringAlignment.Far);
        }
        private static readonly Color Cyan=Theme.Accent, Violet=Color.FromArgb(163,163,163), Pale=Color.FromArgb(115,115,115);
        private static bool Completed(Dictionary<string,object> r){return new[]{"success","already","observed"}.Contains(Json.Get(r,"status"));}
        internal int[] DailyCounts(bool completed){var counts=new int[7];foreach(var r in History){DateTimeOffset t;if(!DateTimeOffset.TryParse(Json.Get(r,"time"),out t))continue;int day=(t.LocalDateTime.Date-DateTime.Today.AddDays(-6)).Days;if(day>=0&&day<7&&Completed(r)==completed)counts[day]++;}return counts;}
        internal object ChartEvidence(){return new {source="/admin/records?limit=100",historyRows=History.Length,enabledAccounts=EnabledAccounts.Length,rangeDays=7,metric="record-count-not-credits",completedStatuses=new[]{"success","already","observed"},completedCounts=DailyCounts(true),otherCounts=DailyCounts(false),noSyntheticData=true};}
        private void Series(Graphics g,RectangleF plot,int[] counts,int maximum,Color color){var pts=new PointF[7];for(int i=0;i<7;i++)pts[i]=new PointF(plot.X+plot.Width*i/6,plot.Bottom-plot.Height*counts[i]/maximum);using(var area=new GraphicsPath()){area.AddLines(pts);area.AddLine(pts[6],new PointF(plot.Right,plot.Bottom));area.AddLine(new PointF(plot.Right,plot.Bottom),new PointF(plot.Left,plot.Bottom));area.CloseFigure();using(var fill=new LinearGradientBrush(plot,Color.FromArgb(34,color),Color.FromArgb(0,color),90f))g.FillPath(fill,area);}using(var p=new Pen(color,2f)){p.StartCap=LineCap.Round;p.EndCap=LineCap.Round;p.LineJoin=LineJoin.Round;g.DrawLines(p,pts);}using(var core=new SolidBrush(Theme.Surface))using(var edge=new Pen(color,1.6f))foreach(var pt in pts){g.FillEllipse(core,pt.X-3.4f,pt.Y-3.4f,6.8f,6.8f);g.DrawEllipse(edge,pt.X-3.4f,pt.Y-3.4f,6.8f,6.8f);}}
        protected override void OnPaint(PaintEventArgs e){if(ClientSize.Width<=2||ClientSize.Height<=2)return;var g=e.Graphics;g.Clear(Theme.Background);g.SmoothingMode=SmoothingMode.AntiAlias;float scale=g.DpiX/96f;g.ScaleTransform(scale,scale);float w=Width/scale;if(w<820){PaintCompact(g,w);return;}
            float gap=14,right=Math.Max(292,w*.31f),left=w-right-gap;var a=new RectangleF(1,1,left-2,216);var b=WideAccountBounds(w);
            UiMetrics.Card(g,a,12);UiMetrics.Card(g,b,12);
            UiMetrics.Text(g,"领取趋势",16,Theme.Ink,new RectangleF(20,13,left-40,28),true);UiMetrics.Text(g,"最近 100 条记录 · 近 7 天 · 次数 / 非积分",10,Pale,new RectangleF(20,42,left-40,20));
            int[] ok=DailyCounts(true),other=DailyCounts(false);int max=Math.Max(4,ok.Concat(other).Max());max=(int)(Math.Ceiling(max/4.0)*4);var plot=new RectangleF(43,85,left-70,88);
            for(int i=0;i<=4;i++){float y=plot.Y+plot.Height*i/4;using(var pen=new Pen(Color.FromArgb(238,238,238)))g.DrawLine(pen,plot.X,y,plot.Right,y);UiMetrics.Text(g,(max-max*i/4).ToString(),9,Pale,new RectangleF(8,y-7,27,15),false,"Segoe UI",StringAlignment.Far);}
            Series(g,plot,other,max,Violet);Series(g,plot,ok,max,Cyan);
            for(int i=0;i<7;i++)UiMetrics.Text(g,DateTime.Today.AddDays(i-6).ToString("MM-dd"),9,Pale,new RectangleF(plot.X+plot.Width*i/6-20,177,40,18),false,"Segoe UI",StringAlignment.Center);
            UiMetrics.Box(g,new RectangleF(left-188,21,8,8),Cyan,4);UiMetrics.Text(g,"完成 / 已领",10,Pale,new RectangleF(left-173,15,82,20));UiMetrics.Box(g,new RectangleF(left-82,21,8,8),Violet,4);UiMetrics.Text(g,"其他",10,Pale,new RectangleF(left-67,15,54,20));
            if(History.Length==0)UiMetrics.Text(g,"暂无领取记录",12,Pale,new RectangleF(plot.X,112,plot.Width,24),false,"Microsoft YaHei UI",StringAlignment.Center);
            UiMetrics.Text(g,"账号构成",16,Theme.Ink,new RectangleF(b.X+18,13,b.Width-36,28),true);UiMetrics.Text(g,"仅统计已启用账号，不合计不同平台额度",9,Pale,new RectangleF(b.X+18,43,b.Width-36,20));
            var groups=EnabledAccounts.GroupBy(x=>Json.Get(x,"platform")).ToArray();Color[] palette={Color.FromArgb(24,24,27),Color.FromArgb(63,63,70),Color.FromArgb(113,113,122),Color.FromArgb(161,161,170),Color.FromArgb(212,212,216)};float diameter=116,cx=b.X+78,cy=128;var ring=new RectangleF(cx-diameter/2,cy-diameter/2,diameter,diameter);using(var pen=new Pen(Color.FromArgb(240,240,240),19))g.DrawEllipse(pen,ring);float start=-90;
            for(int i=0;i<groups.Length;i++){float angle=360f*groups[i].Count()/EnabledAccounts.Length;using(var pen=new Pen(palette[i%palette.Length],19))g.DrawArc(pen,ring,start+1,Math.Max(1,angle-3));start+=angle;}
            var legend=AccountLegendRows();var legendRects=AccountLegendTextRects(b);for(int i=0;i<legend.Length;i++){UiMetrics.Box(g,new RectangleF(b.X+157,76+i*23,7,7),i==5&&groups.Length>6?Pale:palette[i%palette.Length],3);UiMetrics.Text(g,legend[i].Key+"  "+legend[i].Value,10,Pale,legendRects[i]);}
            UiMetrics.Text(g,EnabledAccounts.Length.ToString(),29,Theme.Ink,new RectangleF(cx-40,102,80,36),true,"Segoe UI",StringAlignment.Center);UiMetrics.Text(g,"启用账号",10,Pale,new RectangleF(cx-40,138,80,20),false,"Microsoft YaHei UI",StringAlignment.Center);
            string[] labels={"启用账号","余额核验","已启用模型","记录样本"};string[] values={EnabledAccounts.Length.ToString(),Verified+" / "+Platforms,Routes.ToString(),History.Length.ToString()};float cw=(w-3*gap-3)/4;
            for(int i=0;i<4;i++){float x=1+i*(cw+gap);var r=new RectangleF(x,232,cw,73);UiMetrics.Card(g,r,12);UiMetrics.Icon(g,i,x+18,243,Theme.Ink);UiMetrics.Text(g,labels[i],11,Pale,new RectangleF(x+40,238,cw-56,20));UiMetrics.Text(g,values[i],26,Theme.Ink,new RectangleF(x+18,262,cw-36,38),true,"Segoe UI");}
            UiMetrics.Text(g,"平台余额",16,Theme.Ink,new RectangleF(3,316,160,24),true);UiMetrics.Text(g,Schedule,10,Theme.Muted,new RectangleF(173,316,w-178,24),false,"Microsoft YaHei UI",StringAlignment.Far);
        }
    }
    internal sealed class SettingsBoard : ScrollableControl {
        internal Dictionary<string,object> Config;internal string Api;internal SettingsBoard(){DoubleBuffered=true;Dock=DockStyle.Fill;BackColor=Theme.Background;AutoScroll=true;AutoScrollMinSize=new Size(0,(int)(490*UiMetrics.Scale(this)));}
        private void Row(Graphics g,string name,string value,float x,float y,float width){UiMetrics.Text(g,name,12,Theme.Muted,new RectangleF(x,y,145,29));UiMetrics.Text(g,value,12,Theme.Ink,new RectangleF(x+150,y,width-150,29),false,"Microsoft YaHei UI",StringAlignment.Far);}
        protected override void OnPaint(PaintEventArgs e){if(ClientSize.Width<=2||ClientSize.Height<=2)return;var g=e.Graphics;g.Clear(Theme.Background);g.SmoothingMode=SmoothingMode.AntiAlias;float scale=g.DpiX/96f;g.ScaleTransform(scale,scale);g.TranslateTransform(AutoScrollPosition.X/scale,AutoScrollPosition.Y/scale);float w=ClientSize.Width/scale;if(Config==null){UiMetrics.Text(g,"配置尚未载入",14,Theme.Muted,new RectangleF(20,20,w-40,32));return;}
            var schedule=Config["scheduler"] as Dictionary<string,object>;float gap=18,col=(w-gap)/2;RectangleF left=new RectangleF(1,1,col-2,270),right=new RectangleF(col+gap,1,col-2,270);UiMetrics.Card(g,left,12);UiMetrics.Card(g,right,12);
            UiMetrics.Icon(g,4,22,26,Theme.Accent);UiMetrics.Text(g,"每日自动领取",16,Theme.Ink,new RectangleF(53,19,col-73,32),true);UiMetrics.Box(g,new RectangleF(21,65,col-44,49),UiMetrics.AccentSoft,10);UiMetrics.Text(g,Json.Enabled(schedule)?"计划已开启":"计划已暂停",12,Json.Enabled(schedule)?Theme.Success:Theme.Muted,new RectangleF(35,65,110,49),true);UiMetrics.Text(g,Json.Get(schedule,"hour")+":"+Json.Get(schedule,"minute").PadLeft(2,'0'),25,Theme.Accent,new RectangleF(col-142,65,98,49),true,"Segoe UI",StringAlignment.Far);
            Row(g,"启动时检查",object.Equals(schedule.ContainsKey("startup")?schedule["startup"]:false,true)?"开启":"关闭",24,132,col-50);Row(g,"随机延迟",Json.Get(schedule,"jitterSeconds")+" 秒",24,170,col-50);Row(g,"失败重试间隔",Json.Get(schedule,"retryMinutes")+" 分钟",24,208,col-50);
            UiMetrics.Icon(g,1,col+gap+21,26,Theme.Accent);UiMetrics.Text(g,"账号状态摘要",16,Theme.Ink,new RectangleF(col+gap+53,19,col-74,32),true);int i=0;foreach(var a in Json.Rows(Config,"accounts")){float y=64+i*36;if(y>234){UiMetrics.Text(g,"更多账号见“账号管理”",10,Theme.Muted,new RectangleF(col+gap+22,244,col-44,20));break;}UiMetrics.Box(g,new RectangleF(col+gap+22,y+7,8,8),UiMetrics.PlatformColor(Json.Get(a,"platform")),4);UiMetrics.Text(g,Json.Get(a,"label"),12,Theme.Ink,new RectangleF(col+gap+42,y,col-129,25));UiMetrics.Text(g,Json.Enabled(a)?"已启用":"已停用",11,Json.Enabled(a)?Theme.Success:Theme.Muted,new RectangleF(w-87,y,65,25),false,"Microsoft YaHei UI",StringAlignment.Far);i++;}
            float y2=293;UiMetrics.Card(g,new RectangleF(1,y2,w-3,128),12);UiMetrics.Icon(g,2,24,y2+27,Theme.Accent);UiMetrics.Text(g,"本机模型接口",16,Theme.Ink,new RectangleF(55,y2+16,w-80,32),true);UiMetrics.Text(g,(Api??"").TrimEnd('/')+"/v1",16,Theme.Accent,new RectangleF(25,y2+55,w-50,29),true,"Segoe UI");UiMetrics.Text(g,"账号凭据隔离保存；模型导入与路由在“模型路由”页管理。",12,Theme.Muted,new RectangleF(25,y2+89,w-50,23));
            UiMetrics.Text(g,"需要调整规则？点击上方“定时与平台设置”。JSON 编辑保留在“高级配置”中。",11,Theme.Muted,new RectangleF(1,440,w-2,42));
        }
    }
    // Model quotas are independent windows, never a synthetic credit balance.
    internal static class QuotaPresentation {
        internal const int ContentTop=76, GroupHeight=98, FooterHeight=94;
        internal static bool IsQuota(IDictionary<string,object> a){return Json.Get(a,"platform")=="antigravity";}
        internal static bool Stale(IDictionary<string,object> a){return object.Equals(a.ContainsKey("quotaStale")?a["quotaStale"]:false,true)||object.Equals(a.ContainsKey("stale")?a["stale"]:false,true);}
        internal static string Error(IDictionary<string,object> a){string q=Json.Get(a,"quotaError");if(!string.IsNullOrWhiteSpace(q))return q;object raw;if(a.TryGetValue("error",out raw)&&raw!=null){var d=raw as Dictionary<string,object>;return d==null?Convert.ToString(raw):Json.Get(d,"message","查询失败");}return "";}
        internal static string Status(IDictionary<string,object> a){bool known=object.Equals(a.ContainsKey("quotaKnown")?a["quotaKnown"]:false,true);string state=Stale(a)?"缓存额度 · 待刷新":known?"已获取分组额度":"额度未获取";return state+(Error(a).Length>0?" · "+Error(a):"");}
        internal static Dictionary<string,object>[] Groups(IDictionary<string,object> a){var groups=Json.Rows(a,"quotaGroups").ToArray();if(groups.Length>0)return groups;return new[]{new Dictionary<string,object>{{"id","gemini"},{"displayName","Gemini 模型"}},new Dictionary<string,object>{{"id","claude-gpt"},{"displayName","Claude / GPT 模型"}}};}
        internal static Dictionary<string,object>[] Buckets(IDictionary<string,object> group){return new[]{"weekly","5h"}.Select(window=>Json.Rows(group,"buckets").FirstOrDefault(b=>Json.Get(b,"window")==window)??new Dictionary<string,object>{{"window",window},{"remainingFraction",null},{"resetTime",null}}).ToArray();}
        internal static string Window(IDictionary<string,object> b){return Json.Get(b,"window")=="weekly"?"每周限额剩余":"5 小时限额剩余";}
        internal static string Percent(IDictionary<string,object> b){double n;object value;if(!b.TryGetValue("remainingFraction",out value)||value==null||!double.TryParse(Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out n)||double.IsNaN(n)||double.IsInfinity(n)||n<0||n>1)return "未知";return (n*100).ToString("0.#",System.Globalization.CultureInfo.InvariantCulture)+"%";}
        internal static string Reset(IDictionary<string,object> b,DateTimeOffset now){DateTimeOffset reset;if(!DateTimeOffset.TryParse(Json.Get(b,"resetTime"),out reset))return "重置时间未知";TimeSpan delta=reset-now;if(delta.TotalSeconds<=0)return "已到重置时间 · 待刷新";if(delta.TotalDays>=1)return (int)delta.TotalDays+" 天 "+delta.Hours+" 小时后重置";if(delta.TotalHours>=1)return (int)delta.TotalHours+" 小时 "+delta.Minutes+" 分后重置";return Math.Max(1,(int)Math.Ceiling(delta.TotalMinutes))+" 分钟后重置";}
        internal static string Summary(IDictionary<string,object> a){return string.Join("；",Groups(a).Select(group=>Json.Get(group,"displayName")+"："+string.Join("，",Buckets(group).Select(b=>Window(b)+Percent(b)))));}
        // 等高卡片内的紧凑布局：返回内容区高度，供卡片绘制与内部测试共用同一个数字。
        internal const int CompactTop=72, CompactRowStep=27, CompactGroupGap=4, CompactFooterReserve=76;
        internal static int CompactContentBottom(IDictionary<string,object> a){
            float y=CompactTop;
            foreach(var group in Groups(a)){y+=18;y+=Buckets(group).Length*CompactRowStep-CompactRowStep+18;y+=CompactGroupGap;}
            return (int)y;
        }
        internal static int CompactAvailableHeight(){return UiMetrics.CardHeight-CompactFooterReserve;}
    }
    internal static class NvidiaPresentation {
        internal const int ContentTop=76, ModeHeight=20, RowHeight=19, FooterHeight=116;
        internal const int DecisionRowHeight=27, DecisionFooterHeight=108;
        // 卡片等高约束下的紧凑行高（详情窗仍用上面的完整行高）。
        internal const int CompactRowHeight=19;
        internal static Dictionary<string,object> Object(IDictionary<string,object> a,string key){object value;return a.TryGetValue(key,out value)&&value is Dictionary<string,object>?(Dictionary<string,object>)value:new Dictionary<string,object>();}
        internal static Dictionary<string,object> State(IDictionary<string,object> a){return Object(a,"nvidiaSummary");}
        internal static bool HasState(IDictionary<string,object> a){return State(a).Count>0;}
        internal static string LocalStamp(IDictionary<string,object> a,string key){DateTimeOffset t;return DateTimeOffset.TryParse(Json.Get(a,key),out t)?t.ToLocalTime().ToString("MM-dd HH:mm:ss"):"尚无记录";}
        internal static bool RecentFailure(IDictionary<string,object> a){var auth=Object(State(a),"authentication");DateTimeOffset bad,good;return DateTimeOffset.TryParse(Json.Get(auth,"lastFailureAt"),out bad)&&(!DateTimeOffset.TryParse(Json.Get(auth,"lastSuccessAt"),out good)||bad>good);}
        internal static Color BadgeColor(IDictionary<string,object> a){if(HasState(a)&&RecentFailure(a))return Theme.Warning;if(HasState(a)&&DecisionStatus(a)=="历史已验证")return Theme.Success;return CredentialStatus(a)=="已验证"?Theme.Success:CredentialStatus(a)=="认证失败"?Theme.Danger:Theme.Warning;}
        internal static string DecisionStatus(IDictionary<string,object> a){var auth=Object(State(a),"authentication");if(RecentFailure(a))return "最近失败";if(object.Equals(auth.ContainsKey("everAuthenticated")?auth["everAuthenticated"]:false,true))return "历史已验证";return CredentialStatus(a);}
        internal static string Cooldown(IDictionary<string,object> a,DateTimeOffset now){var rate=Object(State(a),"rateLimit");DateTimeOffset until;if(!DateTimeOffset.TryParse(Json.Get(rate,"cooldownUntil"),out until))return "未记录冷却";double seconds=(until-now).TotalSeconds;if(seconds<=0)return "冷却结束 · 可重试";var span=TimeSpan.FromSeconds(Math.Ceiling(seconds));return span.TotalHours>=1?(int)span.TotalHours+"时 "+span.Minutes+"分后恢复":span.Minutes+"分 "+span.Seconds.ToString("00")+"秒后恢复";}
        internal static KeyValuePair<string,string>[] DecisionRows(IDictionary<string,object> a,DateTimeOffset now){var state=State(a);var auth=Object(state,"authentication");var models=Object(state,"models");var usage=Object(state,"usageToday");var policy=Object(state,"policy");var quota=Quota(a);return new[]{new KeyValuePair<string,string>("认证历史",object.Equals(auth.ContainsKey("everAuthenticated")?auth["everAuthenticated"]:false,true)?"曾成功调用":CredentialStatus(a)),new KeyValuePair<string,string>("最近成功",LocalStamp(auth,"lastSuccessAt")),new KeyValuePair<string,string>(Count(quota,"requestLimit","").Length>0?"响应头窗口上限":"官方公示速率",Count(quota,"requestLimit","").Length>0?Count(quota,"requestLimit","")+" 次 / 窗口":"最高 "+Count(policy,"publishedRpm","待同步")+" RPM"),new KeyValuePair<string,string>("官方公示日上限",Count(policy,"publishedDailyRequests","待同步")+" 次"),new KeyValuePair<string,string>("免费目录 / 聊天",Count(models,"freeTotal","待同步")+" / "+Count(models,"freeChatCount","待同步")),new KeyValuePair<string,string>("可选导入 / 已通过",Count(models,"importableCount","待同步")+" / "+Count(models,"verifiedCount","—")),new KeyValuePair<string,string>("待核验 / 非聊天",Count(models,"pendingCount","—")+" / "+Count(models,"otherTypesCount","—")),new KeyValuePair<string,string>("今日本网关请求",Count(usage,"success","—")+" 成功 / "+Count(usage,"failed","—")+" 失败"),new KeyValuePair<string,string>("今日本网关 Token",Count(usage,"totalTokens","待记录")),new KeyValuePair<string,string>("限流恢复",Cooldown(a,now))};}
        // 主卡只保留决策状态与关键量；完整说明留在 UsageDetailsForm 与 DecisionRows。
        internal static KeyValuePair<string,string>[] CompactRows(IDictionary<string,object> a,DateTimeOffset now){var models=Object(State(a),"models");var usage=Object(State(a),"usageToday");var policy=Object(State(a),"policy");var quota=Quota(a);string window=Count(quota,"requestLimit",""),rpm=Count(policy,"publishedRpm",Count(quota,"requestLimit","待同步"));return new[]{
            new KeyValuePair<string,string>("免费聊天 已验证 / 待核验",Count(models,"verifiedCount","待同步")+" / "+Count(models,"pendingCount","待同步")),
            new KeyValuePair<string,string>("免费聊天目录",Count(models,"freeChatCount","待同步")+" 个"),
            new KeyValuePair<string,string>("公示速率 / 日上限","最高 "+rpm+" RPM / "+Count(policy,"publishedDailyRequests",Count(quota,"dailyLimit","待同步"))+" 次"),
            new KeyValuePair<string,string>("今日本机请求",Count(usage,"success","—")+" 成功 / "+Count(usage,"failed","—")+" 失败"),
            new KeyValuePair<string,string>("今日本机 Token",ActivityData.ShortText(Count(usage,"totalTokens","待记录"))),
            new KeyValuePair<string,string>("限流恢复",Cooldown(a,now))};}
        internal static string CompactSummary(IDictionary<string,object> a){return "免费开发访问 · 动态限流；"+DecisionStatus(a)+"；"+string.Join("；",CompactRows(a,DateTimeOffset.UtcNow).Select(row=>row.Key+"："+row.Value))+"；本网关用量不代表官方剩余额度；积分余额不适用（官方已取消积分制）";}
        internal static string DecisionSummary(IDictionary<string,object> a){return "免费开发访问 · 动态限流；"+DecisionStatus(a)+"；"+string.Join("；",DecisionRows(a,DateTimeOffset.UtcNow).Select(row=>row.Key+"："+row.Value))+"；本网关用量不代表官方剩余额度；积分余额不适用（官方已取消积分制）";}
        internal static string ModelCategory(IDictionary<string,object> model){string c=Json.Get(model,"category","unknown");return c=="chat"?"聊天":c=="embedding"?"向量":c=="rerank"||c=="ranking"?"重排":c=="image"?"图像":c=="audio"||c=="speech"?"音频":c=="video"?"视频":c=="vision"?"视觉":c=="other"?"其他":c=="unknown"?"待分类":c;}
        internal static string ModelStatus(IDictionary<string,object> m){var audit=Object(m,"audit");string state=Json.Get(m,"status",Json.Get(m,"availability",Json.Get(audit,"status","pending")));return state=="passed"||state=="available"?"已通过":state=="pending"||state=="untested"||state=="unverified"?"待核验":state=="chat_verified"?"对话已验证":state=="uncertain"?"待复测":state=="unavailable"?"当前不可用":state=="skipped"?"未检测":state=="discovered"?"仅目录发现":state=="retryable"?"待重试":state=="running"?"检测中":state=="cancelled"?"已中止":state=="partial"?"部分通过":state=="failed"?"最近失败":state=="timeout"?"超时 · 待重试":state=="unsupported"?"专用 API 类型":state;}
        internal static bool IsNvidia(IDictionary<string,object> a){return Json.Get(a,"platform")=="nvidia";}
        internal static Dictionary<string,object> Quota(IDictionary<string,object> a){object value;return a.TryGetValue("quota",out value)&&value is Dictionary<string,object>?(Dictionary<string,object>)value:new Dictionary<string,object>();}
        internal static string CredentialStatus(IDictionary<string,object> a){string state=Json.Get(Quota(a),"credentialStatus","missing");return state=="authenticated"?"已验证":state=="catalog_verified"?"目录已连接":state=="configured"||state=="unverified"?"待核验":state=="rejected"?"认证失败":state=="missing"?"待配置":"待核验";}
        internal static string Count(IDictionary<string,object> q,string key,string fallback){object v;decimal n;if(!q.TryGetValue(key,out v)||v==null||!decimal.TryParse(Convert.ToString(v,System.Globalization.CultureInfo.InvariantCulture),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out n)||n<0)return fallback;return n.ToString("#,##0.###",System.Globalization.CultureInfo.InvariantCulture);}
        internal static KeyValuePair<string,string>[] Rows(IDictionary<string,object> a){var q=Quota(a);var rows=new List<KeyValuePair<string,string>>();rows.Add(new KeyValuePair<string,string>("每日额度",Count(q,"dailyLimit","未公布")));rows.Add(new KeyValuePair<string,string>("剩余额度",Count(q,"remaining","未知")));rows.Add(new KeyValuePair<string,string>("当前窗口请求上限",Count(q,"requestLimit","动态 / 未公布")));rows.Add(new KeyValuePair<string,string>("当前窗口剩余请求",Count(q,"requestRemaining","未知")));DateTimeOffset reset;if(DateTimeOffset.TryParse(Json.Get(q,"resetAt"),out reset))rows.Add(new KeyValuePair<string,string>("窗口重置",reset.ToLocalTime().ToString("MM-dd HH:mm:ss")));string retry=Count(q,"retryAfterSeconds","");if(retry.Length>0)rows.Add(new KeyValuePair<string,string>("重试等待",retry+" 秒"));return rows.ToArray();}
        internal static string Note(IDictionary<string,object> a){return CredentialStatus(a)=="认证失败"?"官方接口认证失败，请更新本机私有 JSON 文件中的 apiKey 后重新核验。":CredentialStatus(a)=="待配置"?"请在本机私有 JSON 文件填写 apiKey，再重新核验。":Json.Get(a,"note","免费开发 API 采用动态限流；额度与模型可用性以官方实际响应为准。");}
        internal static string Source(IDictionary<string,object> a){return Json.Get(Quota(a),"source")=="official_response_headers"?"官方响应头":"官方策略说明";}
        internal static string Summary(IDictionary<string,object> a){return "免费开发 API / 动态限流；"+CredentialStatus(a)+"；"+string.Join("；",Rows(a).Select(row=>row.Key+"："+row.Value));}
        internal static Dictionary<string,object> NewAccount(){return new Dictionary<string,object>{{"id","nvidia-"+DateTime.Now.ToString("MMddHHmmss")},{"label","NVIDIA 官方 API"},{"platform","nvidia"},{"enabled",true},{"credentials",new Dictionary<string,object>{{"kind","file"},{"file",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-credit-gateway","nvidia","credential.json")}}},{"tasks",new object[0]}};}
        internal static void ValidateAccount(Dictionary<string,object> account){if(!IsNvidia(account))return;object raw;var credentials=account.TryGetValue("credentials",out raw)?raw as Dictionary<string,object>:null;if(credentials==null||Json.Get(credentials,"kind")!="file"||!Path.IsPathRooted(Json.Get(credentials,"file"))||credentials.Keys.Any(key=>key!="kind"&&key!="file"))throw new Exception("NVIDIA 凭据只填写 kind=file 和本机 JSON 文件绝对路径。");if(ContainsSecretField(account))throw new Exception("请将 API Key 填入本机私有 JSON 文件，管理配置只保存 credentials.file 引用。");}
        private static bool ContainsSecretField(object value){var dict=value as Dictionary<string,object>;if(dict!=null)return dict.Any(pair=>new[]{"apikey","api_key","accesstoken","access_token","token","authorization","cookie","password","secret","headers"}.Contains(pair.Key.ToLowerInvariant())||ContainsSecretField(pair.Value));var list=value as System.Collections.IEnumerable;if(list!=null&&!(value is string))foreach(object item in list)if(ContainsSecretField(item))return true;return false;}
        internal const string CredentialHint="NVIDIA 官方免费开发 API：本页只填写账号与本机文件引用。请在 credentials.file 指向的私有 JSON 中保存 apiKey；密钥不填入此编辑器。没有每日固定额度承诺，不创建签到任务。";
    }
    internal static class PlatformPresentation {
        internal static readonly string[] Additional = {"qoder","codebuddy","workbuddyai","cline","codearts","lobster","raccoon","loomy","vidu","pixverse"};
        internal static string Name(string p){switch(p){case "workbuddy":return "WorkBuddy";case "qwenwork":return "千问办公";case "trae":return "Trae CN";case "minimax":return "MiniMax Code";case "bigmodel":return "智谱 BigModel";case "antigravity":return "Antigravity";case "nvidia":return "NVIDIA NIM";case "zcode":return "ZCode";case "qoder":return "Qoder";case "codebuddy":return "CodeBuddy";case "workbuddyai":return "WorkBuddy AI";case "cline":return "Cline";case "codearts":return "CodeArts";case "lobster":return "LobsterAI";case "raccoon":return "小浣熊 Raccoon";case "loomy":return "Loomy";case "vidu":return "Vidu 视频";case "pixverse":return "PixVerse 视频";case "jimeng":return "即梦 Jimeng";case "kling":return "可灵 Kling";case "xiaoyunque":return "小云雀";case "hailuo":return "海螺 Hailuo";case "liblib":return "Liblib 哩布哩布";default:return string.IsNullOrWhiteSpace(p)?"未知平台":p;}}
        internal static bool IsVideo(IDictionary<string,object> data){return new[]{"vidu","pixverse","jimeng","kling","xiaoyunque","hailuo","liblib"}.Contains(Json.Get(data,"platform"));}
        internal static string VideoBadge(IDictionary<string,object> data){
            var daily=NvidiaPresentation.Object(data,"dailyCheckin");string state=Json.Get(daily,"status");
            if(object.Equals(data.ContainsKey("stale")?data["stale"]:null,true))return "签到待核验";
            if(state=="not_available")return Json.Get(data,"platform")=="hailuo"?"无每日签到":"无每日领取资格";
            if(!object.Equals(daily.ContainsKey("known")?daily["known"]:null,true))return "签到待核验";
            if(state=="claimed"&&object.Equals(daily.ContainsKey("todayCheckedIn")?daily["todayCheckedIn"]:null,true))return "今日已签到";
            if(state=="observed"&&Json.Get(daily,"credits")=="0")return "今日已核验 · 0积分";
            return state=="claimable"?"待领取":"签到待核验";
        }
        internal static Color VideoBadgeColor(IDictionary<string,object> data){string badge=VideoBadge(data);return badge=="今日已签到"||badge.StartsWith("今日已核验")?Theme.Success:badge.StartsWith("无每日")?Theme.Muted:Theme.Warning;}
        internal static bool IsAdditional(IDictionary<string,object> data){return Additional.Contains(Json.Get(data,"platform"))||IsVideo(data);}
        internal static string Subtitle(IDictionary<string,object> data){string platform=Json.Get(data,"platform"),edition=Json.Get(data,"edition"),label=Json.Get(data,"label");if(IsVideo(data))return (edition=="global"||Json.Get(data,"websiteUrl").Contains("klingai.com")||Json.Get(data,"websiteUrl").Contains("hailuoai.video")?"国际站":"国内站")+" · 每日积分 · 仅签到";if(IsAdditional(data)){string region=edition=="cn"?"国内版":edition=="global"?"国际版":"本机账号";return region+(label.Length>0?" · "+label:"");}return platform=="qwenwork"?"我的 AI 团队":platform=="bigmodel"?"官方 API · 资源包独立计量":platform=="antigravity"?"专用本机协议桥":platform=="nvidia"?"免费开发 API":"国内版 · 本机账号";}
        internal static bool? Checkin(IDictionary<string,object> data){var cap=NvidiaPresentation.Object(data,"capabilities");object value;if(cap.TryGetValue("checkin",out value)&&value is bool)return (bool)value;if(data.TryGetValue("supportsCheckin",out value)&&value is bool)return (bool)value;return null;}
        internal static string HealthBadge(IDictionary<string,object> data){var health=NvidiaPresentation.Object(data,"health");var error=NvidiaPresentation.Object(data,"error");string state=Json.Get(data,"credentialStatus",Json.Get(data,"authenticationStatus",Json.Get(health,"status",Json.Get(data,"status")))).ToLowerInvariant(),code=Json.Get(error,"code").ToLowerInvariant();if(state=="session_expired"||Json.Get(health,"status").ToLowerInvariant()=="session_expired")return "登录已过期";if(code=="provider_auth_rejected")return "接口拒绝";if(code=="provider_identity_missing")return "身份待核验";if(code=="provider_region_mismatch"||code=="provider_region_unknown")return "版本待核验";if(code=="provider_decrypt_failed"||code=="provider_storage_format")return "登录读取失败";if(code=="provider_network_error"||code=="provider_timeout"||code=="balance_timeout")return "连接待恢复";if(state=="missing"||state=="not_logged_in"||state=="login_required"||state=="not_configured"||code.Contains("credential_missing")||code.Contains("login_required")||code.Contains("not_logged"))return "待登录 / 配置";if(state=="rejected"||state=="expired"||code.Contains("unauthorized")||code.Contains("expired"))return "登录待更新";if(error.Count>0||state=="error"||state=="failed")return "待检查";if(IsVideo(data))return VideoBadge(data);if(Json.Get(data,"platform")=="loomy"||Json.Get(data,"platform")=="raccoon")return DailyQuotaBadge(data);var checkin=NvidiaPresentation.Object(health,"checkin");if(object.Equals(data.ContainsKey("checkinKnown")?data["checkinKnown"]:null,false)||object.Equals(checkin.ContainsKey("known")?checkin["known"]:null,false)||Json.Get(data,"checkinError").Length>0||Json.Get(checkin,"error").Length>0)return "签到待核验";if(Json.Get(data,"checkinKind",Json.Get(checkin,"kind"))=="pet_work"){object claimable=data.ContainsKey("claimable")?data["claimable"]:(checkin.ContainsKey("claimable")?checkin["claimable"]:null);if(object.Equals(claimable,true))return "待领取";if(object.Equals(data.ContainsKey("checkedIn")?data["checkedIn"]:null,true))return "宠物奖励已领取";if(object.Equals(claimable,false))return "每日额度自动更新";return "额度状态待核验";}if(Checkin(data)==false)return "无每日签到";if(object.Equals(data.ContainsKey("checkedIn")?data["checkedIn"]:false,true))return "今日已签到";if(Checkin(data)==true)return "待领取";return IsAdditional(data)?"能力待核验":"待领取";}
        internal static string DailyQuotaBadge(IDictionary<string,object> data){var balance=NvidiaPresentation.Object(NvidiaPresentation.Object(data,"health"),"balance");Func<string,object> field=key=>data.ContainsKey(key)?data[key]:(balance.ContainsKey(key)?balance[key]:null);string platform=Json.Get(data,"platform"),source=Convert.ToString(field("dailyQuotaSource")),day=Convert.ToString(field("dailyCycleDate"));DateTimeOffset observed;decimal quota;bool stale=object.Equals(data.ContainsKey("stale")?data["stale"]:null,true);bool trusted=platform=="loomy"?source=="/api/v1/points/first-login":source=="/api/web/points/v1/bills:daily_grant";bool verified=object.Equals(field("dailyQuotaObserved"),true)&&!stale&&trusted&&DateTimeOffset.TryParse(Convert.ToString(field("dailyQuotaObservedAt")),out observed)&&observed.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd")==DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd")&&day==DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd")&&decimal.TryParse(Convert.ToString(field("dailyQuota")),out quota)&&quota>=0;return verified?(platform=="raccoon"?"今日签到额度已到账":"今日额度已到账"):(platform=="raccoon"?"每日签到领取":"每日额度自动更新");}
        internal static Color ColorFor(string p){switch(p){case "qoder":return Color.FromArgb(79,70,229);case "codebuddy":return Color.FromArgb(37,99,235);case "workbuddyai":return Color.FromArgb(5,150,105);case "cline":return Color.FromArgb(82,82,91);case "codearts":return Color.FromArgb(220,38,38);case "lobster":return Color.FromArgb(234,88,12);case "raccoon":return Color.FromArgb(124,58,237);case "loomy":return Color.FromArgb(8,145,178);default:return Color.FromArgb(234,88,12);}}
        internal static string DefaultFile(string platform,string edition){return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ai-credit-gateway",platform+(edition.Length>0?"-"+edition:""),"credential.json");}
        internal static string DefaultKind(string platform){return platform=="qoder"||platform=="codebuddy"||platform=="workbuddyai"||platform=="codearts"||platform=="lobster"?"desktop":"file";}
        internal static Dictionary<string,object> NewAccount(string platform,string edition,string id,string label,string file,string kind="file"){if(!Additional.Contains(platform))throw new InvalidOperationException("请选择已支持的平台");if(string.IsNullOrWhiteSpace(id)||kind!="file"&&kind!="desktop"||kind=="file"&&(string.IsNullOrWhiteSpace(file)||!Path.IsPathRooted(file)))throw new InvalidOperationException("请检查账号 ID 与凭据来源；私有 JSON 必须使用绝对路径");if(kind=="desktop"&&DefaultKind(platform)!="desktop")throw new InvalidOperationException("该平台请使用本机私有 JSON 引用");var data=new Dictionary<string,object>{{"id",id.Trim()},{"label",string.IsNullOrWhiteSpace(label)?Name(platform):label.Trim()},{"platform",platform},{"enabled",false},{"credentials",new Dictionary<string,object>{{"kind",kind},{"file",kind=="desktop"?"auto":file.Trim()}}},{"tasks",new object[0]}};if(platform=="qoder"||platform=="codearts"||platform=="lobster"||platform=="vidu"||platform=="pixverse")data["tasks"]=new object[]{new Dictionary<string,object>{{"id","daily-checkin"},{"enabled",true}}};if(platform=="workbuddyai")data["edition"]="global";if(platform=="qoder"||platform=="codebuddy"){if(edition!="cn"&&edition!="global")throw new InvalidOperationException("请选择国内版或国际版");data["edition"]=edition;}return data;}
    }
    internal sealed class PlatformAccountDialog : ProductForm {
        internal Dictionary<string,object> Value;private readonly ComboBox source=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill},platform=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill},edition=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill};private readonly TextBox id=new TextBox {Dock=DockStyle.Fill},label=new TextBox {Dock=DockStyle.Fill},file=new TextBox {Dock=DockStyle.Fill};
        internal PlatformAccountDialog(){Text="添加平台账号 · 本机文件引用";Size=new Size(740,530);MinimumSize=new Size(640,530);Font=Theme.Body;BackColor=Theme.Background;StartPosition=FormStartPosition.CenterParent;Padding=new Padding(24);var layout=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,ColumnCount=2};layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110));layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));Control[] fields={platform,edition,id,label,source,file};string[] names={"平台","版本","账号 ID","显示名称","凭据来源","凭据 JSON"};for(int i=0;i<fields.Length;i++){layout.RowStyles.Add(new RowStyle(SizeType.Absolute,42));layout.Controls.Add(new Label {Text=names[i],AutoSize=true,Margin=new Padding(0,7,4,0)},0,i);layout.Controls.Add(fields[i],1,i);}platform.Items.AddRange(PlatformPresentation.Additional.Select(p=>PlatformPresentation.Name(p)+" / "+p).ToArray());edition.Items.AddRange(new object[]{"国内版 CN","国际版 Global"});edition.SelectedIndex=0;source.Items.AddRange(new object[]{"读取本机登录（只读）","私有 JSON 文件引用"});source.SelectedIndexChanged+=(s,e)=>UpdateSource();platform.SelectedIndexChanged+=(s,e)=>Reset();edition.SelectedIndexChanged+=(s,e)=>Reset();var hint=new Label {Dock=DockStyle.Fill,Text="本机登录模式只读现有应用登录；私有JSON模式仅保存本机文件路径。新账号默认停用；Qoder、CodeArts、Lobster及Vidu、PixVerse预设每日签到，启用账号后自动执行。Vidu、PixVerse仅领取视频积分，无模型反代；登录凭据保存在私有JSON文件。CodeBuddy CN沿用WorkBuddy共享领取。",ForeColor=Theme.Muted,Padding=new Padding(0,8,0,8)};var footer=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=48,FlowDirection=FlowDirection.RightToLeft};var save=Theme.Button("添加配置");var cancel=Theme.Button("取消");save.Click+=(s,e)=>{try{Value=PlatformPresentation.NewAccount(PlatformPresentation.Additional[platform.SelectedIndex],edition.SelectedIndex==1?"global":"cn",id.Text,label.Text,file.Text,source.SelectedIndex==0?"desktop":"file");DialogResult=DialogResult.OK;}catch(Exception x){MessageBox.Show(this,x.Message,"检查账号引用");}};cancel.Click+=(s,e)=>DialogResult=DialogResult.Cancel;footer.Controls.Add(save);footer.Controls.Add(cancel);Controls.Add(hint);Controls.Add(layout);Controls.Add(footer);platform.SelectedIndex=0;}
        private void UpdateSource(){if(platform.SelectedIndex<0)return;string p=PlatformPresentation.Additional[platform.SelectedIndex],region=p=="qoder"||p=="codebuddy"?(edition.SelectedIndex==1?"global":"cn"):p=="workbuddyai"?"global":"";bool desktop=source.SelectedIndex==0;file.Enabled=!desktop;file.Text=desktop?"auto（只读本机应用登录）":PlatformPresentation.DefaultFile(p,region);}
        private void Reset(){if(platform.SelectedIndex<0)return;string p=PlatformPresentation.Additional[platform.SelectedIndex];bool regional=p=="qoder"||p=="codebuddy";edition.Enabled=regional;if(p=="workbuddyai"&&edition.SelectedIndex!=1)edition.SelectedIndex=1;string region=regional?(edition.SelectedIndex==1?"global":"cn"):p=="workbuddyai"?"global":"";id.Text=p+(region.Length>0?"-"+region:"")+"-main";label.Text=PlatformPresentation.Name(p)+(region=="cn"?" 国内版":region=="global"?" 国际版":"");source.Enabled=PlatformPresentation.DefaultKind(p)=="desktop";source.SelectedIndex=source.Enabled?0:1;UpdateSource();}
    }

    // Only known official HTTPS origins can be opened. The explicit executable bypasses the default browser.
    internal static class VideoNavigation {
        internal static Action<ProcessStartInfo> Launch=info=>{Process.Start(info);};
        internal static string Url(IDictionary<string,object> data){
            string p=Json.Get(data,"platform"),edition=Json.Get(data,"edition"),url;string[] hosts;
            switch(p){
                case "vidu":url="https://www.vidu.cn/";hosts=new[]{"www.vidu.cn","vidu.cn"};break;
                case "pixverse":url="https://app.pixverse.ai/";hosts=new[]{"app.pixverse.ai"};break;
                case "jimeng":url="https://jimeng.jianying.com/ai-tool/home";hosts=new[]{"jimeng.jianying.com"};break;
                case "kling":url=edition=="global"?"https://app.klingai.com/global/":"https://klingai.kuaishou.com/";hosts=new[]{"klingai.kuaishou.com","app.klingai.com","klingai.com","www.klingai.com"};break;
                case "xiaoyunque":url="https://xyq.jianying.com/";hosts=new[]{"xyq.jianying.com","www.xiaoyunque.com"};break;
                case "hailuo":url=edition=="global"?"https://hailuoai.video/":"https://hailuoai.com/";hosts=new[]{"hailuoai.com","www.hailuoai.com","hailuoai.video","www.hailuoai.video"};break;
                case "liblib":url="https://www.liblib.art/";hosts=new[]{"liblib.art","www.liblib.art","liblib.tv","www.liblib.tv"};break;
                default:throw new InvalidOperationException("该卡片没有视频平台入口");
            }
            Uri supplied;if(Uri.TryCreate(Json.Get(data,"websiteUrl"),UriKind.Absolute,out supplied)&&supplied.Scheme==Uri.UriSchemeHttps&&supplied.IsDefaultPort&&supplied.UserInfo.Length==0&&hosts.Contains(supplied.Host.ToLowerInvariant()))url=supplied.GetLeftPart(UriPartial.Authority)+"/";
            return url;
        }
        internal static ProcessStartInfo Build(IDictionary<string,object> data){
            string url=Url(data);string[] roots={Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)};
            foreach(string root in roots){if(root.Length==0)continue;string exe=Path.Combine(root,"Microsoft","Edge","Application","msedge.exe");if(File.Exists(exe))return new ProcessStartInfo(exe,"\""+url+"\""){UseShellExecute=true};}
            return new ProcessStartInfo("microsoft-edge:"+url){UseShellExecute=true};
        }
        internal static void Open(IDictionary<string,object> data){Launch(Build(data));}
    }
    internal sealed class CreditCard : Panel {
        // 等高卡片：所有平台共用同一高度，长内容进详情窗（NVIDIA 主卡只留决策摘要）。
        internal const int UniformHeight=UiMetrics.CardHeight;
        internal int PreferredHeight {get{return UniformHeight;}}
        internal readonly Color AccentColor;internal readonly Dictionary<string,object> Data;internal string AccountKey {get{return accountKey;}}internal bool MotionActive {get{return motionSubscribed;}}private readonly Button check,detail,enter;private bool hover;private float hoverLevel,enterLevel=1f;private readonly Action motionTick;private bool motionSubscribed;private readonly string accountKey;
        internal CreditCard(Dictionary<string,object> data,Color accent,Action refresh,Action showDetails){Data=data;AccentColor=accent;accountKey=Json.Get(data,"accountId",Json.Get(data,"label","card"));BackColor=Theme.Surface;DoubleBuffered=true;SetStyle(ControlStyles.OptimizedDoubleBuffer|ControlStyles.AllPaintingInWmPaint,true);AccessibleRole=AccessibleRole.Grouping;check=Theme.Button("重新核验");detail=Theme.Button("额度明细");check.Click+=(s,e)=>refresh();detail.Click+=(s,e)=>showDetails();Controls.Add(check);if(PlatformPresentation.IsVideo(data)){enter=Theme.Button("进入");enter.AccessibleName="在 Edge 中进入"+PlatformPresentation.Name(Json.Get(data,"platform"));enter.Click+=(s,e)=>{try{VideoNavigation.Open(Data);}catch(Exception error){MessageBox.Show(FindForm(),error.Message,"打开平台入口",MessageBoxButtons.OK,MessageBoxIcon.Information);}};Controls.Add(enter);}Controls.Add(detail);RefreshAccessibility();motionTick=()=>{float hoverTarget=hover?1:0;hoverLevel+=(hoverTarget-hoverLevel)*.3f;enterLevel+=(1f-enterLevel)*.22f;bool settled=Math.Abs(hoverTarget-hoverLevel)<.012f&&1f-enterLevel<.012f;if(settled){hoverLevel=hoverTarget;enterLevel=1f;StopMotion();}Invalidate();};MouseEnter+=(s,e)=>{hover=true;StartMotion();};MouseLeave+=(s,e)=>{hover=false;StartMotion();};}
        private void StartMotion(){if(!MotionPolicy.Active){hoverLevel=hover?1:0;enterLevel=1f;Invalidate();return;}if(!motionSubscribed){motionSubscribed=true;MotionClock.Subscribe(motionTick);}}
        private void StopMotion(){if(motionSubscribed){motionSubscribed=false;MotionClock.Unsubscribe(motionTick);}}
        // 内容更新（非重建）：整份替换键值，避免已恢复的错误/旧值残留；淡入一次，不重建控件也不重置滚动。
        internal void RefreshContent(Dictionary<string,object> data){if(data==null)return;if(!object.ReferenceEquals(Data,data)){Data.Clear();foreach(var pair in data)Data[pair.Key]=pair.Value;}RefreshAccessibility();enterLevel=MotionPolicy.Active?0f:1f;StartMotion();Invalidate(true);}
        private void RefreshAccessibility(){string platform=Json.Get(Data,"platform");AccessibleName=Json.Get(Data,"label")+"，余额 "+Json.Get(Data,"value","待获取")+Json.Get(Data,"unit");AccessibleDescription=Json.Get(Data,"note");if(PlatformPresentation.IsAdditional(Data))AccessibleName=PlatformPresentation.Name(platform)+"，"+PlatformPresentation.Subtitle(Data)+"，"+PlatformPresentation.HealthBadge(Data)+"，余额 "+Json.Get(Data,"value","待获取")+Json.Get(Data,"unit");if(QuotaPresentation.IsQuota(Data)){AccessibleName=Json.Get(Data,"label")+"，"+QuotaPresentation.Status(Data);AccessibleDescription=QuotaPresentation.Summary(Data);}if(NvidiaPresentation.IsNvidia(Data)){AccessibleName=Json.Get(Data,"label")+"，"+NvidiaPresentation.CredentialStatus(Data);AccessibleDescription=NvidiaPresentation.HasState(Data)?NvidiaPresentation.DecisionSummary(Data):NvidiaPresentation.Summary(Data);}}
        protected override void OnResize(EventArgs e){base.OnResize(e);if(check==null||detail==null)return;float s=UiMetrics.Scale(this);int inset=(int)(24*s),gap=(int)(10*s),count=enter==null?2:3,bw=Math.Max(1,(Width-inset*2-gap*(count-1))/count);int top=(int)((PreferredHeight-44)*s);check.SetBounds(inset,top,bw,(int)(32*s));if(enter!=null)enter.SetBounds(inset+bw+gap,top,bw,(int)(32*s));detail.SetBounds(inset+(bw+gap)*(count-1),top,Math.Max(1,Width-inset-(inset+(bw+gap)*(count-1))),(int)(32*s));Invalidate();}
        private string LocalTime(string key,string format){DateTimeOffset d;return DateTimeOffset.TryParse(Json.Get(Data,key),out d)?d.ToLocalTime().ToString(format):"—";}
        protected override void OnPaint(PaintEventArgs e){if(ClientSize.Width<=2||ClientSize.Height<=2)return;var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.TextRenderingHint=TextRenderingHint.ClearTypeGridFit;g.Clear(Theme.Background);float s=g.DpiX/96f;g.ScaleTransform(s,s);float w=Width/s;float appear=1f-Math.Max(0f,Math.Min(1f,enterLevel));var r=new RectangleF(2,2,w-5,PreferredHeight-10);
            using(var path=UiMetrics.Round(r,UiMetrics.Radius)){var sh=r;sh.Offset(0,1);using(var sb=new SolidBrush(Color.FromArgb(hover?20:10,15,23,25)))using(var sp=UiMetrics.Round(sh,UiMetrics.Radius))g.FillPath(sb,sp);using(var b=new SolidBrush(UiMetrics.Mix(Theme.Surface,Theme.Background,hoverLevel*.25f)))g.FillPath(b,path);using(var pen=new Pen(hoverLevel>.02f?UiMetrics.AccentMid:UiMetrics.Line,1))g.DrawPath(pen,path);}
            string platform=Json.Get(Data,"platform"),name=PlatformPresentation.Name(platform);UiMetrics.Box(g,new RectangleF(22,18,38,38),UiMetrics.AccentSoft,11);var icon=PlatformLogoCache.Get(platform);if(icon!=null)g.DrawImage(icon,new RectangleF(27,23,28,28));else UiMetrics.Text(g,name.Substring(0,1),18,platform=="nvidia"?AccentColor:Theme.Ink,new RectangleF(22,18,38,38),true,"Segoe UI",StringAlignment.Center);
            UiMetrics.Text(g,name,14,Theme.Ink,new RectangleF(70,14,w-210,26),true);UiMetrics.Text(g,PlatformPresentation.Subtitle(Data),10,Theme.Muted,new RectangleF(70,39,w-95,18));
            bool bad=Data.ContainsKey("error"),stale=object.Equals(Data.ContainsKey("stale")?Data["stale"]:false,true);bool done=object.Equals(Data.ContainsKey("checkedIn")?Data["checkedIn"]:false,true);string badge=platform=="nvidia"?(NvidiaPresentation.HasState(Data)?NvidiaPresentation.DecisionStatus(Data):NvidiaPresentation.CredentialStatus(Data)):PlatformPresentation.IsAdditional(Data)?PlatformPresentation.HealthBadge(Data):bad?"待检查":platform=="antigravity"?"模型配额":platform=="bigmodel"?"官方 API":platform=="qwenwork"?"自动刷新":PlatformPresentation.HealthBadge(Data);Color statusColor=platform=="nvidia"?NvidiaPresentation.BadgeColor(Data):bad?Theme.Danger:PlatformPresentation.IsVideo(Data)?PlatformPresentation.VideoBadgeColor(Data):platform=="bigmodel"?Theme.Muted:platform=="qwenwork"?Theme.Muted:PlatformPresentation.Checkin(Data)==false?Theme.Muted:done?Theme.Success:Theme.Warning;float badgeWidth=Math.Max(84,Math.Min(PlatformPresentation.IsVideo(Data)?160:120,badge.Length*10+16));UiMetrics.Box(g,new RectangleF(w-23-badgeWidth,17,badgeWidth,24),UiMetrics.Mix(statusColor,Color.White,.88f),8);UiMetrics.Text(g,badge,10,statusColor,new RectangleF(w-23-badgeWidth,17,badgeWidth,24),true,"Microsoft YaHei UI",StringAlignment.Center);
            if(NvidiaPresentation.IsNvidia(Data)){PaintNvidia(g,w);}else if(QuotaPresentation.IsQuota(Data)){PaintQuota(g,w);}else{
                UiMetrics.Text(g,"可用余额"+(stale?" · 上次成功值":""),11,Theme.Muted,new RectangleF(24,76,w-48,20));string amount="待获取";if(Data.ContainsKey("value")&&Data["value"]!=null)amount=Convert.ToDecimal(Data["value"]).ToString("#,##0.###");float size=amount.Length>10?28:36;using(var f=new Font("Segoe UI",size,FontStyle.Bold,GraphicsUnit.Pixel)){var measure=g.MeasureString(amount,f);UiMetrics.Text(g,amount,size,Theme.Ink,new RectangleF(22,98,w-46,46),true,"Segoe UI");if(measure.Width<w-85)UiMetrics.Text(g,Json.Get(Data,"unit"),12,Theme.Muted,new RectangleF(25+measure.Width,114,65,25));}
                string note=bad?Json.Get(Data["error"] as Dictionary<string,object>,"message"):Json.Get(Data,"note");UiMetrics.Text(g,note,11,bad?Theme.Warning:Theme.Muted,new RectangleF(24,150,w-48,52));}
            float footer=PreferredHeight-76;using(var pen=new Pen(UiMetrics.Line))g.DrawLine(pen,24,footer,w-24,footer);
            bool quotaCard=QuotaPresentation.IsQuota(Data)&&!NvidiaPresentation.IsNvidia(Data);
            UiMetrics.Text(g,"核验 "+LocalTime(quotaCard?"quotaFetchedAt":"checkedAt","HH:mm:ss"),10,Theme.Muted,new RectangleF(24,footer+6,w-165,20));
            UiMetrics.Text(g,LocalTime(quotaCard?"quotaFetchedAt":"expiresAt","MM-dd HH:mm"),10,Theme.Ink,new RectangleF(w-141,footer+6,117,20),false,"Segoe UI",StringAlignment.Far);
            
            if(appear>0.01f){using(var veil=new SolidBrush(Color.FromArgb((int)(appear*70),Theme.Surface)))using(var p=UiMetrics.Round(r,UiMetrics.Radius))g.FillPath(veil,p);}
        }
        private void PaintNvidia(Graphics g,float w){bool state=NvidiaPresentation.HasState(Data);float y=NvidiaPresentation.ContentTop;UiMetrics.Text(g,state?"免费开发访问 · 动态限流":"免费开发 API / 动态限流",12,Theme.Ink,new RectangleF(24,y,w-48,NvidiaPresentation.ModeHeight),true);y+=NvidiaPresentation.ModeHeight+2;
            if(state){var rows=NvidiaPresentation.CompactRows(Data,DateTimeOffset.UtcNow);foreach(var row in rows){UiMetrics.Text(g,row.Key,10,Theme.Muted,new RectangleF(24,y,(w-48)*.5f,NvidiaPresentation.CompactRowHeight));UiMetrics.Text(g,row.Value,10,Theme.Ink,new RectangleF(24+(w-48)*.5f,y,(w-48)*.5f,NvidiaPresentation.CompactRowHeight),true,"Microsoft YaHei UI",StringAlignment.Far);y+=NvidiaPresentation.CompactRowHeight;}UiMetrics.Text(g,"更多字段见额度明细；本网关用量非官方剩余额度。",9,Theme.Muted,new RectangleF(24,y+4,w-48,20));}
            else{foreach(var row in NvidiaPresentation.Rows(Data)){UiMetrics.Text(g,row.Key,10,Theme.Muted,new RectangleF(24,y,(w-48)*.5f,NvidiaPresentation.CompactRowHeight));UiMetrics.Text(g,row.Value,10,Theme.Ink,new RectangleF(24+(w-48)*.5f,y,(w-48)*.5f,NvidiaPresentation.CompactRowHeight),true,"Microsoft YaHei UI",StringAlignment.Far);y+=NvidiaPresentation.CompactRowHeight;}string error=QuotaPresentation.Error(Data);UiMetrics.Text(g,error.Length>0?error:NvidiaPresentation.Note(Data),9,error.Length>0?Theme.Warning:Theme.Muted,new RectangleF(24,y+4,w-48,32));}
        }
        // 等高卡片内的紧凑配额视图：4 个桶全部保留（2 组 × 2 桶），状态行贴底不越过 footer。
        private void PaintQuota(Graphics g,float w){float y=QuotaPresentation.CompactTop;foreach(var group in QuotaPresentation.Groups(Data)){UiMetrics.Text(g,Json.Get(group,"displayName",Json.Get(group,"id")),12,Theme.Ink,new RectangleF(24,y,w-48,18),true);float row=y+19;foreach(var b in QuotaPresentation.Buckets(group)){UiMetrics.Text(g,QuotaPresentation.Window(b),10,Theme.Muted,new RectangleF(24,row,w-112,18));string percent=QuotaPresentation.Percent(b);UiMetrics.Text(g,percent,13,percent=="未知"?Theme.Muted:Theme.Ink,new RectangleF(w-91,row,67,18),true,"Segoe UI",StringAlignment.Far);UiMetrics.Text(g,QuotaPresentation.Reset(b,DateTimeOffset.UtcNow),9,Theme.Muted,new RectangleF(24,row+13,w-48,13));row+=QuotaPresentation.CompactRowStep;}y=row+QuotaPresentation.CompactGroupGap;}
            float statusTop=Math.Min(y,QuotaPresentation.CompactAvailableHeight()-18);UiMetrics.Text(g,QuotaPresentation.Status(Data),10,QuotaPresentation.Error(Data).Length>0||QuotaPresentation.Stale(Data)?Theme.Warning:Theme.Muted,new RectangleF(24,statusTop,w-48,18));
        }
        protected override void Dispose(bool disposing){if(disposing){StopMotion();}base.Dispose(disposing);}
    }
    internal class ProductForm : Form {
        private readonly int uiThreadId=Thread.CurrentThread.ManagedThreadId;
        private bool creatingNativeHandle,disposeAfterCreate;
        private volatile bool uiStopping;
        internal ProductForm(){Icon=BrandAssets.AppIcon;}
        // The owner thread and an existing handle are both required. InvokeRequired alone
        // returns false before creation/after teardown and must not authorize UI access.
        protected bool UpdateUi(Action update){
            if(uiStopping||IsDisposed||Disposing||!IsHandleCreated)return false;
            if(Thread.CurrentThread.ManagedThreadId==uiThreadId&&!creatingNativeHandle){
                if(uiStopping||IsDisposed||Disposing)return false;
                update();return true;
            }
            try{BeginInvoke(new Action(()=>{
                if(!uiStopping&&!IsDisposed&&!Disposing&&IsHandleCreated)update();
            }));return true;}
            catch(InvalidOperationException){if(uiStopping||IsDisposed||Disposing||!IsHandleCreated)return false;throw;}
        }
        protected override void CreateHandle(){
            creatingNativeHandle=true;
            try{base.CreateHandle();}
            finally{
                creatingNativeHandle=false;
                if(disposeAfterCreate){
                    disposeAfterCreate=false;
                    if(IsHandleCreated)BeginInvoke(new Action(()=>Dispose()));
                    else base.Dispose(true);
                }
            }
        }
        protected override void OnFormClosing(FormClosingEventArgs e){
            base.OnFormClosing(e);if(!e.Cancel)uiStopping=true;
        }
        protected override void Dispose(bool disposing){
            if(disposing){
                uiStopping=true;
                // A HandleCreated callback still runs inside Control.CreateHandle.
                // Finish that creation, then release the form on the next UI message.
                if(creatingNativeHandle){disposeAfterCreate=true;return;}
            }
            base.Dispose(disposing);
        }
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd,int attribute,ref int value,int size);
        
        [StructLayout(LayoutKind.Sequential)] internal struct FrameRect { internal int Left,Top,Right,Bottom; }
        [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] private static extern int GetFrameBounds(IntPtr hwnd,int attribute,out FrameRect value,int size);
        internal void CaptureCompositedFrame(string path){FrameRect r;if(GetFrameBounds(Handle,9,out r,16)!=0)throw new Exception("DWM frame bounds unavailable");using(var bitmap=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)){using(var g=Graphics.FromImage(bitmap))g.CopyFromScreen(r.Left,r.Top,0,0,bitmap.Size);bitmap.Save(path,ImageFormat.Png);}}
        internal int CaptionResult,BorderResult,TextResult;
        private void ApplyChrome(){if(uiStopping||IsDisposed||Disposing||!IsHandleCreated)return;int dark=1,caption=ColorTranslator.ToWin32(Color.White),border=ColorTranslator.ToWin32(Color.FromArgb(229,229,229)),text=ColorTranslator.ToWin32(Color.FromArgb(23,23,23));try{DwmSetWindowAttribute(Handle,20,ref dark,4);CaptionResult=DwmSetWindowAttribute(Handle,35,ref caption,4);BorderResult=DwmSetWindowAttribute(Handle,34,ref border,4);TextResult=DwmSetWindowAttribute(Handle,36,ref text,4);}catch(DllNotFoundException){CaptionResult=BorderResult=TextResult=-1;}catch(EntryPointNotFoundException){CaptionResult=BorderResult=TextResult=-1;}}
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);ApplyChrome();}
        protected override void OnActivated(EventArgs e){base.OnActivated(e);ApplyChrome();MotionClock.Suspended=false;}
        protected override void OnDeactivate(EventArgs e){base.OnDeactivate(e);ApplyChrome();UpdateUi(()=>{MotionClock.Suspended=Application.OpenForms.Cast<Form>().All(f=>!f.ContainsFocus);});}
        internal object ChromeEvidence(){return new {captionResult=CaptionResult,borderResult=BorderResult,textResult=TextResult,requestedCaptionColor=ColorTranslator.ToWin32(Color.White),requestedBorderColor=ColorTranslator.ToWin32(Color.FromArgb(229,229,229)),requestedTextColor=ColorTranslator.ToWin32(Color.White),nativeFrame=FormBorderStyle==FormBorderStyle.Sizable};}
    }
    internal sealed class JsonDialog : ProductForm {
        private readonly TextBox editor = Theme.Output(); internal Dictionary<string, object> Value;
        internal JsonDialog(string title, Dictionary<string, object> value, string hint = null) {
            Text = title; Font = Theme.Body; Size = new Size(720, 570); MinimumSize = new Size(560, 430); StartPosition = FormStartPosition.CenterParent; Padding = new Padding(Theme.Padding); BackColor = Theme.Background;
            editor.ReadOnly = false; editor.Text = Json.Pretty(value);
            var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, FlowDirection = FlowDirection.RightToLeft };
            var save = Theme.Button("确认修改"); var cancel = Theme.Button("取消"); footer.Controls.Add(save); footer.Controls.Add(cancel); Controls.Add(editor); Controls.Add(footer); if(!string.IsNullOrWhiteSpace(hint))Controls.Add(new Label {Text=hint,Dock=DockStyle.Top,Height=86,ForeColor=Theme.Muted,Padding=new Padding(4)});
            save.Click += (s, e) => { try { Value = Json.Object(editor.Text); DialogResult = DialogResult.OK; } catch { MessageBox.Show(this, "JSON 格式有误，请检查后重试。", "配置格式"); } }; cancel.Click += (s, e) => DialogResult = DialogResult.Cancel;
        }
    }
    internal sealed class UsageDetailsForm : ProductForm {
        private const int ColumnWidth=120, TimeWidth=215, ModelWidth=220, DetailHeight=140, ToolbarHeight=90;
        private readonly Gateway backend; private readonly string accountId; private readonly System.Windows.Forms.Timer quotaTimer=new System.Windows.Forms.Timer {Interval=30000};
        private float enterLevel;private readonly Action motionTick;private bool motionSubscribed;private SurfaceTransition exitTransition;private bool exitComplete;
        internal readonly DataGridView Calls=Theme.Grid("开始时间","实际模型","路由","上游 / 账号","结果","模式 / 来源","耗时","首字耗时","输入 Token","输出 Token","缓存 Token","推理 Token","消耗积分","计费金额","计费依据");
        internal readonly DataGridView Changes=Theme.Grid("核验时间","前次核验","前次余额","当前余额","变化","数据口径");
        private readonly TextBox detail=Theme.Output(), model=new TextBox {Width=190};
        private readonly DateTimePicker from=new DateTimePicker {Width=125,Format=DateTimePickerFormat.Short,Value=DateTime.Today.AddDays(-6)},to=new DateTimePicker {Width=125,Format=DateTimePickerFormat.Short,Value=DateTime.Today};
        private readonly ComboBox filterStatus=new ComboBox {Width=105,DropDownStyle=ComboBoxStyle.DropDownList};
        private readonly Label message=new Label {Dock=DockStyle.Bottom,Height=44,ForeColor=Theme.Muted};
        private readonly Button refresh=Theme.Button("刷新明细"),more=Theme.Button("加载更多"),export=Theme.Button("导出已加载明细");
        private long? cursor; private bool loading; private string activeQuery;
        internal UsageDetailsForm(Gateway gateway,Dictionary<string,object> a) {
            backend=gateway;accountId=Json.Get(a,"accountId");motionTick=FadeStep;Text=Json.Get(a,"label")+" · 额度明细";Size=new Size(1280,820);MinimumSize=new Size(980,660);StartPosition=FormStartPosition.CenterParent;Padding=new Padding(Theme.Padding);Font=Theme.Body;BackColor=Theme.Background;
            var title=new Label {Dock=DockStyle.Top,Height=58,Font=Theme.Title,ForeColor=Theme.Ink,Text=Json.Get(a,"label")+"   "+(NvidiaPresentation.IsNvidia(a)?"免费 API / 动态限流":QuotaPresentation.IsQuota(a)?"分组额度":Json.Get(a,"value","待获取")+" "+Json.Get(a,"unit"))};
            var tabs=new TabControl {Dock=DockStyle.Fill};TabPage usagePage=new TabPage("模型调用明细"),balancePage=new TabPage("余额变化核验"),packagePage=new TabPage("额度与套餐");tabs.TabPages.AddRange(new[]{usagePage,balancePage,packagePage});
            var bar=new FlowLayoutPanel {Dock=DockStyle.Top,Height=ToolbarHeight,Padding=new Padding(8),WrapContents=true};
            filterStatus.Items.AddRange(new object[]{"全部结果","完成","失败","取消 / 中断","进行中"});filterStatus.SelectedIndex=0;
            foreach(var c in new Control[]{new Label {Text="日期",AutoSize=true},from,to,new Label {Text="实际模型（精确ID）",AutoSize=true},model,filterStatus,refresh,more,export})bar.Controls.Add(c);
            var split=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1100,540),SplitterDistance=360,FixedPanel=FixedPanel.Panel2};Shown+=(s,e)=>{if(split.Height>DetailHeight+220){split.Panel2MinSize=DetailHeight;split.SplitterDistance=split.Height-DetailHeight-4;}};split.Panel1.Controls.Add(Calls);split.Panel2.Controls.Add(detail);usagePage.Controls.Add(split);usagePage.Controls.Add(bar);usagePage.Controls.Add(message);
            Calls.AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.None;foreach(DataGridViewColumn c in Calls.Columns)c.Width=ColumnWidth;Calls.Columns[0].Width=TimeWidth;Calls.Columns[1].Width=ModelWidth;Calls.Columns[2].Width=ModelWidth;Calls.Columns[12].DisplayIndex=2;Calls.Columns[6].DisplayIndex=3;Calls.Columns[7].DisplayIndex=4;Calls.Columns[4].DisplayIndex=5;Calls.Columns[4].Width=90;Calls.Columns[12].Width=105;Calls.Columns[6].Width=105;
            Calls.SelectionChanged+=(s,e)=>{if(Calls.CurrentRow!=null&&Calls.CurrentRow.Tag!=null)detail.Text=Describe((Dictionary<string,object>)Calls.CurrentRow.Tag);};
            balancePage.Controls.Add(Changes);balancePage.Controls.Add(new Label {Dock=DockStyle.Top,Height=60,Text="平台余额核验窗口的差额，包含所有消费、领取、套餐到期等变化；不冒充单次模型请求的精确扣费。不同单位不合计。",ForeColor=Theme.Muted});
            var packages=Theme.Grid("额度 / 套餐","剩余","适用模型 / 场景","状态","到期时间");packages.DefaultCellStyle.WrapMode=DataGridViewTriState.True;packages.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.AllCells;
            if(NvidiaPresentation.IsNvidia(a)){packages.Columns[0].HeaderText="额度 / 窗口";packages.Columns[1].HeaderText="官方返回值";packages.Columns[2].HeaderText="计量来源";packages.Columns[4].HeaderText="观测时间";foreach(var row in NvidiaPresentation.Rows(a))packages.Rows.Add(row.Key,row.Value,NvidiaPresentation.Source(a),NvidiaPresentation.CredentialStatus(a),LocalTime(Json.Get(NvidiaPresentation.Quota(a),"observedAt")));tabs.SelectedTab=packagePage;}
            else if(QuotaPresentation.IsQuota(a)){packages.Columns[0].HeaderText="模型组 / 周期";packages.Columns[1].HeaderText="剩余额度";packages.Columns[2].HeaderText="重置倒计时";packages.Columns[4].HeaderText="重置时间";foreach(var group in QuotaPresentation.Groups(a))foreach(var bucket in QuotaPresentation.Buckets(group))packages.Rows.Add(Json.Get(group,"displayName")+" / "+QuotaPresentation.Window(bucket),QuotaPresentation.Percent(bucket),QuotaPresentation.Reset(bucket,DateTimeOffset.UtcNow),QuotaPresentation.Status(a),LocalTime(Json.Get(bucket,"resetTime")));tabs.SelectedTab=packagePage;}
            else foreach(var part in Json.Rows(a,"parts"))packages.Rows.Add(Json.Get(part,"name"),Json.Get(part,"value","未返回")+" "+Json.Get(part,"unit",Json.Get(a,"unit")),Json.Get(part,"scope","—"),Json.Get(part,"status","—"),LocalTime(Json.Get(part,"expiresAt")));
            if(packages.Rows.Count==0)packages.Rows.Add("平台余额",Json.Get(a,"value","未返回")+" "+Json.Get(a,"unit"),"—","—",LocalTime(Json.Get(a,"expiresAt")));
            if(QuotaPresentation.IsQuota(a)){quotaTimer.Tick+=(sender,args)=>{int index=0;foreach(var group in QuotaPresentation.Groups(a))foreach(var bucket in QuotaPresentation.Buckets(group)){packages.Rows[index++].Cells[2].Value=QuotaPresentation.Reset(bucket,DateTimeOffset.UtcNow);}};quotaTimer.Start();}
            packagePage.Controls.Add(packages);var packageHint=new Label {Dock=DockStyle.Top,Height=70,ForeColor=Theme.Muted,Text="核验时间："+LocalTime(Json.Get(a,QuotaPresentation.IsQuota(a)?"quotaFetchedAt":"checkedAt"))+"   "+(QuotaPresentation.IsQuota(a)?QuotaPresentation.Status(a):Json.Get(a,"note"))+(object.Equals(a.ContainsKey("stale")?a["stale"]:false,true)?" · 缓存余额":"")+(a.ContainsKey("error")?" · 余额查询失败，见原始结果":"")+(a.ContainsKey("packagesError")&&a["packagesError"]!=null?" · 资源包查询异常，需要控制台登录态":"")};packagePage.Controls.Add(packageHint);
            if(NvidiaPresentation.IsNvidia(a)&&NvidiaPresentation.HasState(a)){
                var state=NvidiaPresentation.State(a);var local=NvidiaPresentation.Object(state,"usageToday");var auth=NvidiaPresentation.Object(state,"authentication");var modelState=NvidiaPresentation.Object(state,"models");var settings=NvidiaPresentation.Object(state,"settings");
                packagePage.Text="官方限额";packages.Rows.Clear();var published=NvidiaPresentation.Object(state,"policy");packages.Rows.Add("官方公示速率","最高 "+NvidiaPresentation.Count(published,"publishedRpm","待同步")+" RPM","NVIDIA Build 通用公示","非账号实时剩余",LocalTime(Json.Get(published,"rateFetchedAt")));packages.Rows.Add("官方公示日请求上限",NvidiaPresentation.Count(published,"publishedDailyRequests","待同步")+" 次","NVIDIA Build 通用公示","可因模型 / 流量调整",LocalTime(Json.Get(published,"rateFetchedAt")));packages.Rows.Add("积分余额","不适用","官方已取消积分制","免费开发访问","—");foreach(var row in NvidiaPresentation.Rows(a).Skip(2))packages.Rows.Add(row.Key,row.Value,NvidiaPresentation.Source(a),"动态限流",LocalTime(Json.Get(NvidiaPresentation.Quota(a),"observedAt")));
                var decisionPage=new TabPage("决策状态");var decision=Theme.Grid("项目","值","口径");decision.DefaultCellStyle.WrapMode=DataGridViewTriState.True;decision.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.AllCells;var quotaObject=NvidiaPresentation.Quota(a);foreach(var row in NvidiaPresentation.DecisionRows(a,DateTimeOffset.UtcNow))decision.Rows.Add(row.Key,row.Value,"决策摘要 · 主卡只显示关键量");foreach(var row in NvidiaPresentation.Rows(a)){bool already=false;foreach(DataGridViewRow existing in decision.Rows)if(Convert.ToString(existing.Cells[0].Value)==row.Key)already=true;if(!already)decision.Rows.Add(row.Key,row.Value,NvidiaPresentation.Source(a));}decision.Rows.Add("限流状态",NvidiaPresentation.Cooldown(a,DateTimeOffset.UtcNow),"官方动态限流");decision.Rows.Add("额度观测时间",NvidiaPresentation.LocalStamp(quotaObject,"observedAt"),NvidiaPresentation.Source(a));decision.Rows.Add("未返回字段",Json.Get(quotaObject,"requestLimit","").Length==0?"响应头窗口上限未返回，保持未知而非 0":"已返回","错误/未知保持原样");decisionPage.Controls.Add(decision);decisionPage.Controls.Add(new Label{Dock=DockStyle.Top,Height=52,ForeColor=Theme.Muted,Text="主卡是等高紧凑视图；这里是完整字段。缺失或错误字段保持未知/错误，不补造数值。"});tabs.TabPages.Add(decisionPage);
                var policy=NvidiaPresentation.Object(state,"policy");string sourceUrl=Json.Get(policy,"rateSourceUrl",Json.Get(policy,"sourceUrl"));Uri uri;if(Uri.TryCreate(sourceUrl,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&((uri.Host=="nvidia.com"||uri.Host.EndsWith(".nvidia.com")))){var link=new LinkLabel{Dock=DockStyle.Bottom,Height=30,Text=Json.Get(policy,"sourceLabel","NVIDIA 官方额度说明")};link.LinkClicked+=(sender,args)=>Process.Start(new ProcessStartInfo(uri.AbsoluteUri){UseShellExecute=true});packagePage.Controls.Add(link);}
                balancePage.Text="本网关用量";balancePage.Controls.Clear();var usage=Theme.Grid("指标","记录值","统计口径");string scope=Json.Get(local,"date","待记录")+" / "+Json.Get(local,"timeZone","本机时区");foreach(var pair in new[]{new[]{"请求数","requests"},new[]{"成功","success"},new[]{"失败","failed"},new[]{"输入 Token","inputTokens"},new[]{"输出 Token","outputTokens"},new[]{"总 Token","totalTokens"},new[]{"未返回 Token 的请求","unknownTokenRequests"}})usage.Rows.Add(pair[0],pair[0].Contains("Token")?ActivityData.ShortText(NvidiaPresentation.Count(local,pair[1],"待记录")):NvidiaPresentation.Count(local,pair[1],"待记录"),scope+" · 网关账本");usage.Rows.Add("认证历史",object.Equals(auth.ContainsKey("everAuthenticated")?auth["everAuthenticated"]:false,true)?"曾成功调用":"尚无成功记录","目录刷新不清除成功历史");usage.Rows.Add("最近成功",NvidiaPresentation.LocalStamp(auth,"lastSuccessAt"),"本网关调用记录");usage.Rows.Add("最近失败",NvidiaPresentation.LocalStamp(auth,"lastFailureAt"),Json.Get(auth,"lastFailureCode")+" "+Json.Get(auth,"lastFailureMessage"));usage.Rows.Add("本机并发上限",NvidiaPresentation.Count(settings,"maxConcurrent","未设置"),"仅限当前网关进程，非官方限额");usage.Rows.Add("本机请求间隔",NvidiaPresentation.Count(settings,"minIntervalMs","未设置")+" 毫秒","仅限当前网关进程，非官方限额");balancePage.Controls.Add(usage);balancePage.Controls.Add(new Label{Dock=DockStyle.Top,Height=55,ForeColor=Theme.Muted,Text="仅统计经过本网关的请求与 Token；不代表官方剩余额度，也不包括绕过本网关的调用。"});
                var modelsPage=new TabPage("逐模型状态");var models=Theme.Grid("模型 ID","类型","状态","最近成功","最近失败 / 原因");models.DefaultCellStyle.WrapMode=DataGridViewTriState.True;models.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.AllCells;foreach(var m in Json.Rows(modelState,"items"))models.Rows.Add(Json.Get(m,"id",Json.Get(m,"model")),NvidiaPresentation.ModelCategory(m),NvidiaPresentation.ModelStatus(m),NvidiaPresentation.LocalStamp(m,"lastSuccessAt"),NvidiaPresentation.LocalStamp(m,"lastFailureAt")+" / "+Json.Get(m,"reason",Json.Get(NvidiaPresentation.Object(m,"audit"),"reason")));if(models.Rows.Count==0)models.Rows.Add("尚未同步模型目录","—","待核验","—","刷新目录后查看；目录发现不等于通过调用测试");modelsPage.Controls.Add(models);modelsPage.Controls.Add(new Label{Dock=DockStyle.Top,Height=55,ForeColor=Theme.Muted,Text="聊天模型可批量选择导入待核验；非聊天类型保留在目录，使用对应专用 API。一次超时不等于永久失效。"});tabs.TabPages.Add(modelsPage);usagePage.Text="本网关调用明细";tabs.SelectedTab=balancePage;
            }
            Controls.Add(tabs);Controls.Add(title);more.Enabled=false;refresh.Click+=async(s,e)=>await LoadUsage(false);more.Click+=async(s,e)=>await LoadUsage(true);export.Click+=(s,e)=>Export();
            Shown+=async(s,e)=>{PlayFade();if(backend!=null)await LoadUsage(false);};FormClosed+=(s,e)=>loading=false;Disposed+=(s,e)=>{quotaTimer.Dispose();StopFade();};
        }
        // 详情窗进场：260ms 淡入，静态内容立即可用；禁用动画时完全不改 Opacity（保持普通窗口）。
        protected override void OnFormClosing(FormClosingEventArgs e){base.OnFormClosing(e);if(e.Cancel||exitComplete||e.CloseReason!=CloseReason.UserClosing||!MotionPolicy.Active||MotionClock.Suspended)return;e.Cancel=true;StopFade();if(exitTransition==null)exitTransition=new SurfaceTransition(this);exitTransition.Exit(this,()=>{exitComplete=true;Close();});}
        protected override void Dispose(bool disposing){if(disposing&&exitTransition!=null)exitTransition.Dispose();base.Dispose(disposing);}
        private void PlayFade(){if(!MotionPolicy.Active){return;}enterLevel=0f;Opacity=.74;if(!motionSubscribed){motionSubscribed=true;MotionClock.Subscribe(motionTick);}}
        private void StopFade(){if(motionSubscribed){motionSubscribed=false;MotionClock.Unsubscribe(motionTick);}try{if(!IsDisposed)Opacity=1;}catch(Exception){}}
        private void FadeStep(){enterLevel+=(1f-enterLevel)*.22f;try{if(!IsDisposed&&Visible)Opacity=Math.Min(1d,.74+.26*enterLevel);}catch(Exception){}if(1f-enterLevel<.02f)StopFade();}
        internal static string LocalTime(string text){DateTimeOffset value;return DateTimeOffset.TryParse(text,out value)?value.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss.fff"):"—";}
        private static string Counter(Dictionary<string,object> r,string key){return Json.Get(r,key,"未返回");}
        private static string Duration(Dictionary<string,object> r,string key){double value;return double.TryParse(Json.Get(r,key),out value)?(value/1000).ToString("0.000")+" 秒":"未返回";}
        private static string Result(string s){return s=="completed"?"完成":s=="failed"?"失败":s=="cancelled"?"取消 / 中断":s=="running"?"进行中 / 未收尾":s;}
        internal static string Describe(Dictionary<string,object> r){return "请求 ID："+Json.Get(r,"requestId")+"   尝试序号："+Json.Get(r,"attempt")+Environment.NewLine+"开始："+LocalTime(Json.Get(r,"startedAt"))+"   结束："+LocalTime(Json.Get(r,"finishedAt"))+Environment.NewLine+"模型："+Json.Get(r,"model")+"   路由："+Json.Get(r,"routeId")+"   账号："+Json.Get(r,"accountLabel")+Environment.NewLine+"耗时："+Duration(r,"durationMs")+"   首字："+Duration(r,"firstTokenMs")+"；这是请求耗时，不是人工使用时长。"+Environment.NewLine+"Token（输入 / 输出 / 总计 / 缓存 / 推理）："+Counter(r,"promptTokens")+" / "+Counter(r,"completionTokens")+" / "+Counter(r,"totalTokens")+" / "+Counter(r,"cachedTokens")+" / "+Counter(r,"reasoningTokens")+Environment.NewLine+"积分："+Counter(r,"credits")+"   金额："+Counter(r,"cost")+" "+Json.Get(r,"costUnit","单位未返回")+"；未返回不等于零，不按 Token 猜测积分。"+Environment.NewLine+(r.ContainsKey("error")?"错误："+Json.Pretty(r["error"]):"结果："+Result(Json.Get(r,"status")));}
        internal void Fill(Dictionary<string,object> report,bool append=false) {
            if(!append)Calls.Rows.Clear();foreach(var r in Json.Rows(report,"records")){int index=Calls.Rows.Add(LocalTime(Json.Get(r,"startedAt")),Json.Get(r,"model"),Json.Get(r,"routeId"),Json.Get(r,"upstreamId")+" / "+Json.Get(r,"accountLabel"),Result(Json.Get(r,"status")),(object.Equals(r.ContainsKey("stream")?r["stream"]:false,true)?"流式":"普通")+(object.Equals(r.ContainsKey("hasTools")?r["hasTools"]:false,true)?" / 工具":"")+" / "+Json.Get(r,"source"),Duration(r,"durationMs"),Duration(r,"firstTokenMs"),Counter(r,"promptTokens"),Counter(r,"completionTokens"),Counter(r,"cachedTokens"),Counter(r,"reasoningTokens"),Counter(r,"credits"),Counter(r,"cost")+" "+Json.Get(r,"costUnit","单位未返回"),Json.Get(r,"chargeSource")=="upstream_usage"?"上游返回":"上游未返回扣费");Calls.Rows[index].Tag=r;}
            Changes.Rows.Clear();foreach(var r in Json.Rows(report,"balanceChanges"))Changes.Rows.Add(LocalTime(Json.Get(r,"checked_at")),LocalTime(Json.Get(r,"previous_at")),Json.Get(r,"previous_value","首次核验")+" "+Json.Get(r,"unit"),Json.Get(r,"value")+" "+Json.Get(r,"unit"),Json.Get(r,"change","—")+" "+Json.Get(r,"unit"),Json.Get(r,"source"));
            long value;cursor=long.TryParse(Json.Get(report,"nextBeforeId"),out value)?(long?)value:null;more.Enabled=cursor.HasValue;message.Text="已加载 "+Calls.Rows.Count+" / "+Json.Get(report,"total")+" 条；仅涵盖记录功能启用后的网关调用。Token 与积分分别显示；历史未记录字段不补造。";if(Calls.Rows.Count>0)detail.Text=Describe((Dictionary<string,object>)(Calls.CurrentRow??Calls.Rows[0]).Tag);if(Calls.Rows.Count==0)detail.Text="此筛选范围暂无已记录调用。先经网关调用模型，再刷新；客户端直接调用不在网关记录内。";
        }
        private async Task LoadUsage(bool append){if(loading)return;loading=true;refresh.Enabled=false;more.Enabled=false;try{if(from.Value.Date>to.Value.Date)throw new Exception("开始日期应早于结束日期");string query="/admin/usage?limit=100&accountId="+Uri.EscapeDataString(accountId)+"&model="+Uri.EscapeDataString(model.Text.Trim())+"&status="+Uri.EscapeDataString(filterStatus.SelectedIndex==0?"":new[]{"","completed","failed","cancelled","running"}[filterStatus.SelectedIndex])+"&from="+Uri.EscapeDataString(from.Value.Date.ToUniversalTime().ToString("o"))+"&to="+Uri.EscapeDataString(to.Value.Date.AddDays(1).AddTicks(-1).ToUniversalTime().ToString("o"));if(append&&query!=activeQuery)append=false;if(append&&cursor.HasValue)query+="&beforeId="+cursor.Value;var report=await backend.Request("GET",query);if(IsDisposed)return;Fill(report,append);if(!append)activeQuery=query;}catch(Exception e){if(!IsDisposed)message.Text="读取明细失败："+e.Message;}finally{loading=false;if(!IsDisposed){refresh.Enabled=true;more.Enabled=cursor.HasValue;}}}
        internal static string Csv(string value){if(!string.IsNullOrEmpty(value)&&"=+-@".Contains(value[0].ToString()))value="'"+value;return "\""+(value??"").Replace("\"","\"\"")+"\"";}
        private void Export(){using(var dialog=new SaveFileDialog {Filter="CSV 明细|*.csv",FileName="额度调用明细.csv"}){if(dialog.ShowDialog(this)!=DialogResult.OK)return;var lines=new List<string>();lines.Add(string.Join(",",Calls.Columns.Cast<DataGridViewColumn>().Select(c=>Csv(c.HeaderText))));foreach(DataGridViewRow row in Calls.Rows)lines.Add(string.Join(",",row.Cells.Cast<DataGridViewCell>().Select(c=>Csv(Convert.ToString(c.Value)))));File.WriteAllLines(dialog.FileName,lines,new UTF8Encoding(true));message.Text="已导出当前加载的 "+Calls.Rows.Count+" 条明细。";}}
    }

    internal static class RouteAuditSelection {
        internal const string Column = "AuditSelected";
        internal static void Configure(DataGridView grid) { grid.ReadOnly=false;foreach(DataGridViewColumn c in grid.Columns)c.ReadOnly=true;var check=new DataGridViewCheckBoxColumn {Name=Column,HeaderText="选测",ReadOnly=false,AutoSizeMode=DataGridViewAutoSizeColumnMode.None,Width=64,SortMode=DataGridViewColumnSortMode.NotSortable};grid.Columns.Add(check);check.DisplayIndex=0;grid.CurrentCellDirtyStateChanged+=(s,e)=>{if(grid.IsCurrentCellDirty&&grid.CurrentCell!=null&&grid.CurrentCell.OwningColumn.Name==Column)grid.CommitEdit(DataGridViewDataErrorContexts.Commit);}; }
        internal static string[] Ids(DataGridView grid) { grid.EndEdit();return grid.Rows.Cast<DataGridViewRow>().Where(r=>object.Equals(r.Cells[Column].Value,true)&&r.Tag is Dictionary<string,object>&&Json.Enabled((Dictionary<string,object>)r.Tag)).Select(r=>Json.Get((Dictionary<string,object>)r.Tag,"id")).Where(id=>id.Length>0).Distinct().ToArray(); }
        internal static void SelectAll(DataGridView grid,bool selected){grid.EndEdit();grid.CurrentCell=null;foreach(DataGridViewRow row in grid.Rows)row.Cells[Column].Value=selected&&row.Visible&&row.Tag is Dictionary<string,object>&&Json.Enabled((Dictionary<string,object>)row.Tag);}
        internal static Dictionary<string,object> Body(DataGridView grid){var ids=Ids(grid);if(ids.Length==0)throw new InvalidOperationException("请至少勾选一个启用路由");return new Dictionary<string,object>{{"scope","selected"},{"routeIds",ids}};}
    }

    internal sealed class MainWindow : ProductForm {
        internal readonly Gateway Backend;
        private bool productionTool;
        private readonly List<Control> productionDiscardedShell = new List<Control>();
        internal static readonly string[] ProductionSections = { "accounts", "routes", "records", "preferences", "diagnostics", "workbuddy", "updates", "operations" };
        private Dictionary<string, object> config;
        private readonly OverviewScrollPanel overviewHost = new OverviewScrollPanel {Dock=DockStyle.Fill,BackColor=Theme.Background};
        private readonly FlowLayoutPanel creditCards = new FlowLayoutPanel { Dock = DockStyle.Top, AutoScroll = false, WrapContents = true, Padding = new Padding(2,2,2,0) };
        private readonly DashboardHeader summary = new DashboardHeader { Dock = DockStyle.Top, Height = 344 };
        private readonly SettingsBoard settingsBoard = new SettingsBoard();
        private readonly List<StudioButton> navigation=new List<StudioButton>();
        private readonly Label pageTitle=new Label {AutoSize=true,Font=Theme.Title,ForeColor=Theme.Ink};
        private readonly Label pageSubtitle=new Label {AutoSize=true,ForeColor=Theme.Muted};
        private int balanceCardCount;private DiagnosticsWorkspace activityBoard;private OperationsBoard operationsBoard;

        private readonly PageDeck tabs = new PageDeck { Dock = DockStyle.Fill };
        private readonly Label status = new Label { Text = "正在连接本机后台…", AutoSize = true, ForeColor = Theme.Muted, Margin = new Padding(0, 5, 15, 0) };
        private readonly TextBox overview = Theme.Output(), details = Theme.Output(), editor = Theme.Output();
        private readonly DataGridView accounts = Theme.Grid("账号 ID", "名称", "平台", "状态", "启用任务"), routes = Theme.Grid("模型 ID", "名称", "状态", "优先级上游"), records = Theme.Grid("时间", "平台 / 账号", "任务", "结果", "详情");
        private readonly NotifyIcon tray = new NotifyIcon(); private readonly bool background; private bool quit; private bool backendPaused; private int reconnectFailures; private bool refreshing; private long modelRefreshMs; private int busy; private readonly System.Windows.Forms.Timer refreshTimer = new System.Windows.Forms.Timer { Interval = 30000 };
        private ScrollAnchor anchor; private bool restoringAnchor; private int cardColumns=3;
        internal MainWindow(Gateway backend, bool startHidden, bool autoConnect = true, bool productionToolMode = false) {
            productionTool=productionToolMode;
            Backend = backend; background = startHidden; Text = "AI网关"; Name = "AiCreditGatewayNativeWindow"; Font = Theme.Body; AutoScaleMode = AutoScaleMode.Dpi;
            Size = new Size(1320, 900); MinimumSize = new Size(780, 700); StartPosition = FormStartPosition.CenterScreen; BackColor = Theme.Background; ForeColor = Theme.Ink; Icon = BrandAssets.AppIcon;

            var body=new Panel {Dock=DockStyle.Fill,BackColor=Theme.Background};var rail=new RailPanel {Dock=DockStyle.Left,Width=UiMetrics.Sidebar};Controls.Add(body);Controls.Add(rail);
            var head=new WorkbenchHeader {Dock=DockStyle.Top,Height=UiMetrics.Header,BackColor=Theme.Surface};pageTitle.BackColor=Color.Transparent;pageSubtitle.BackColor=Color.Transparent;pageTitle.Location=new Point(28,12);pageSubtitle.Location=new Point(29,47);head.Controls.Add(pageTitle);head.Controls.Add(pageSubtitle);
            var headerActions=new FlowLayoutPanel {Dock=DockStyle.Right,Width=340,BackColor=Color.Transparent,Padding=new Padding(8,24,8,0)};AddButton(headerActions,"全部账号签到",ClaimAllAccounts);AddButton(headerActions,"刷新全部余额",async()=>{await Backend.Connect(false);await LoadBalances(true);});((Button)headerActions.Controls[0]).BackColor=Theme.Accent;((Button)headerActions.Controls[0]).ForeColor=Color.White;head.Controls.Add(headerActions);
            var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = UiMetrics.Footer, Padding = new Padding(24,6,20,0), BackColor = Theme.Background };
            AddButton(bar,"启动后台",async()=>{backendPaused=false;await Backend.Connect(true);await LoadAll();});AddButton(bar,"暂停后台",async()=>{await Backend.Request("POST","/admin/shutdown",new object());backendPaused=true;status.Text="后台已暂停 · 自动重连已停止";});bar.Controls.Add(status);
            body.Controls.Add(tabs);body.Controls.Add(bar);body.Controls.Add(head);
            BuildOverview();BuildAccounts();BuildRoutes();BuildRecords();BuildConfig();BuildActivity();BuildWorkBuddy();BuildClientUpdates();BuildOperations();
            var links=new FlowLayoutPanel {Location=new Point(14,122),Width=196,Height=520,Padding=new Padding(0),FlowDirection=FlowDirection.TopDown,WrapContents=false,BackColor=Color.Transparent};rail.Controls.Add(links);
            string[] titles={"积分总览","账号管理","模型路由","领取记录","偏好设置","请求诊断台","wb帐号池","软件更新","运行中心"};string[] subtitles={"查看平台余额，管理每日领取。","维护本机登录态与账号领取规则。","预演请求条件，按优先级配置同款接力。","查询领取结果与失败原因。","设置每日时间、随机延迟与独立功能开关。","诊断请求与接入生效状态；只读检查，不触发生成。","多账号常驻登录、聊天迁移与积分任务。","查看官方版本、重试失败源与完整检查详情。","健康选路、应用密钥、会话、到期权益和异常通知。"};
            for(int i=0;i<titles.Length;i++){int index=i;var nav=new StudioButton {Text=titles[i],Navigation=true,Glyph=i,Selected=i==0,Width=196,Height=44,Margin=new Padding(0,0,0,8),AccessibleName=titles[i]};nav.Click+=async(sender,e)=>{tabs.SelectedIndex=index;if(index==3&&Backend!=null&&Backend.BaseUrl!=null)try{await LoadRecords();}catch(Exception x){ShowError(x);}if(index==5&&Backend!=null&&Backend.BaseUrl!=null)await activityBoard.LoadAsync();if(index==6&&Backend!=null&&Backend.BaseUrl!=null)try{await wbBoard.LoadAsync();}catch(Exception x){ShowError(x);}if(index==7&&Backend!=null&&Backend.BaseUrl!=null)try{await clientUpdatesBoard.LoadAsync();}catch(Exception x){ShowError(x);}if(index==8&&Backend!=null&&Backend.BaseUrl!=null)try{await operationsBoard.LoadAsync();}catch(Exception x){ShowError(x);} };navigation.Add(nav);links.Controls.Add(nav);}
            tabs.SelectedIndexChanged+=(sender,e)=>{for(int i=0;i<navigation.Count;i++){navigation[i].Selected=i==tabs.SelectedIndex;navigation[i].Invalidate();}pageTitle.Text=titles[tabs.SelectedIndex];pageSubtitle.Text=subtitles[tabs.SelectedIndex];};tabs.SelectedIndex=0;
            var menu = new ContextMenuStrip(); menu.Items.Add("打开主窗口", null, (s, e) => Restore()); menu.Items.Add("退出窗口，后台继续", null, (s, e) => { quit = true; Close(); });
            menu.Items.Add("停止后台并退出", null, async (s, e) => { try { await Backend.Request("POST", "/admin/shutdown", new object()); quit = true; Close(); } catch (Exception x) { ShowError(x); } });
            tray.Text = "AI网关"; tray.Icon = Icon; tray.ContextMenuStrip = menu; tray.Visible = !productionToolMode; tray.DoubleClick += (s, e) => Restore();
            FormClosing += (s, e) => { if (!quit && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); tray.ShowBalloonTip(2200, "AI网关", "窗口已收至系统托盘，后台领取与模型接口继续运行。", ToolTipIcon.Info); } };
            Shown += async (s, e) => { if (background) Hide(); if (autoConnect) await Run(async () => { await Backend.Connect(true); await LoadAll(); }); };
            refreshTimer.Tick += async (s,e)=>await RefreshVisiblePages();if(!productionToolMode)refreshTimer.Start();
            // 隐藏/后台挂起全部动效与轮询；恢复时不清滚动位置。
            VisibleChanged += (s,e) => ApplyMotionState();
            Resize += (s,e) => { if(tabs.SelectedIndex==0)ResizeCards(); };
            ApplyMotionState();
        }
        private async Task RefreshVisiblePages(){
            if(busy!=0||refreshing||!Visible||backendPaused)return;
            refreshing=true;bool recover=false;
            try {
                try {
                    if(tabs.SelectedIndex==3)await LoadRecords();
                    else if(tabs.SelectedIndex==0){await LoadBalances();await LoadRecords();}
                    else if(tabs.SelectedIndex==2)await LoadAuditStatuses();
                    else if(tabs.SelectedIndex==5)await activityBoard.LoadAsync();
                    else if(tabs.SelectedIndex==6)await wbBoard.LoadAsync();
                    else if(tabs.SelectedIndex==7)await clientUpdatesBoard.LoadAsync();
                    else if(tabs.SelectedIndex==8)await operationsBoard.LoadAsync();
                    reconnectFailures=0;refreshTimer.Interval=30000;
                } catch(Exception x){recover=true;reconnectFailures++;status.Text="连接检查中 · 第 "+reconnectFailures+" 次 · "+x.Message;}
                if(recover&&!backendPaused){
                    try {await Backend.Connect(reconnectFailures>=2);status.Text="后台连接已恢复 · "+DateTime.Now.ToString("HH:mm:ss");reconnectFailures=0;}
                    catch {status.Text="后台暂未连接 · 正在退避重试；暂停后台可停止重连";}
                    refreshTimer.Interval=Math.Min(30000,2000*(1<<Math.Min(4,reconnectFailures)));
                }
            } finally {refreshing=false;}
        }
        private void ApplyMotionState() {
            bool active = Visible && WindowState != FormWindowState.Minimized && !IsDisposed;
            MotionClock.Suspended = !active;
            refreshTimer.Enabled = active && !productionTool;
        }
        // WS_VISIBLE / a taskbar entry does not prove that a window is on a monitor.
        // RestoreBounds may retain the minimized sentinel (-32000,-32000), a
        // disconnected monitor, or a previous DPI/work-area size.
        internal static Rectangle RecoverWindowBounds(Rectangle bounds, Rectangle[] workingAreas, Rectangle preferredArea) {
            var areas=(workingAreas??new Rectangle[0]).Where(a=>a.Width>0&&a.Height>0).ToArray();
            if(areas.Length==0)areas=new[]{preferredArea.Width>0&&preferredArea.Height>0?preferredArea:new Rectangle(0,0,1320,900)};
            Rectangle area=areas.Contains(preferredArea)?preferredArea:areas[0];long overlap=0;
            foreach(var candidate in areas){var intersection=Rectangle.Intersect(bounds,candidate);long pixels=(long)Math.Max(0,intersection.Width)*Math.Max(0,intersection.Height);if(pixels>overlap){overlap=pixels;area=candidate;}}
            bool offscreen=overlap==0;
            int width=Math.Min(area.Width,Math.Max(offscreen?1320:780,bounds.Width>0?bounds.Width:1320));
            int height=Math.Min(area.Height,Math.Max(offscreen?900:700,bounds.Height>0?bounds.Height:900));
            int x=offscreen?area.Left+(area.Width-width)/2:Math.Max(area.Left,Math.Min(bounds.Left,area.Right-width));
            int y=offscreen?area.Top+(area.Height-height)/2:Math.Max(area.Top,Math.Min(bounds.Top,area.Bottom-height));
            return new Rectangle(x,y,width,height);
        }
        internal void RestoreVisibleWindow() {
            if(IsDisposed||Disposing)return;
            var prior=WindowState;
            var normal=prior==FormWindowState.Normal?Bounds:RestoreBounds;
            var areas=Screen.AllScreens.Select(screen=>screen.WorkingArea).ToArray();
            var preferred=Screen.PrimaryScreen==null?new Rectangle(0,0,1320,900):Screen.PrimaryScreen.WorkingArea;
            var recovered=RecoverWindowBounds(normal,areas,preferred);
            if(prior==FormWindowState.Minimized||recovered!=normal)WindowState=FormWindowState.Normal;
            if(recovered!=normal){StartPosition=FormStartPosition.Manual;Bounds=recovered;}
            Opacity=1;ShowInTaskbar=true;Show();
            if(prior==FormWindowState.Maximized)WindowState=FormWindowState.Maximized;
            BringToFront();Activate();ApplyMotionState();
        }
        internal async void Restore() { RestoreVisibleWindow(); await Run(async () => { await Backend.Connect(false); await LoadAll(); }); }
        private void PrepareProductionTool(string section) {
            int slot=Array.IndexOf(ProductionSections,section);if(slot<0)throw new ArgumentException("管理工具未识别。");
            int index=slot+1; productionTool=true;quit=true;tray.Visible=false;refreshTimer.Stop();
            tabs.SelectedIndex=index;var selected=tabs.Panels[index];
            var runtimeBar=tabs.Parent.Controls.OfType<FlowLayoutPanel>().FirstOrDefault(c=>c.Dock==DockStyle.Bottom);
            selected.Parent=null;if(runtimeBar!=null)runtimeBar.Parent=null;
            foreach(Control child in Controls.Cast<Control>().ToArray())productionDiscardedShell.Add(child);
            Controls.Clear();Controls.Add(selected);selected.Dock=DockStyle.Fill;selected.Visible=true;
            if(runtimeBar!=null){Controls.Add(runtimeBar);runtimeBar.Dock=DockStyle.Bottom;}
            string[] titles={"账号管理","模型路由管理","领取记录详情","网关偏好设置","请求诊断台","WorkBuddy 账号池","软件更新","运行中心"};
            Text=titles[slot]+" · AI 网关";Name="AiCreditGatewayTool_"+section;
            StartPosition=FormStartPosition.CenterParent;Size=new Size(1220,860);MinimumSize=new Size(780,650);
        }
        private async Task LoadProductionToolAsync(string section) {
            await Backend.Connect(false);
            config=await Backend.Request("GET","/admin/config");settingsBoard.Config=config;settingsBoard.Api=Backend.BaseUrl;settingsBoard.Invalidate();editor.Text=Json.Pretty(config);
            accounts.Rows.Clear();routes.Rows.Clear();
            foreach(var account in Json.Rows(config,"accounts"))accounts.Rows.Add(Json.Get(account,"id"),Json.Get(account,"label",Json.Get(account,"id")),Json.Get(account,"platform"),Json.Enabled(account)?"已启用":"已停用",string.Join("、",Json.Rows(account,"tasks").Where(Json.Enabled).Select(t=>Json.Get(t,"id"))));
            var displayedWb=new HashSet<string>();foreach(var route in Json.Rows(config,"routes").Where(Json.Enabled)) {
                var first=Json.Rows(route,"targets").FirstOrDefault();var upstream=first==null?null:Json.Rows(config,"upstreams").FirstOrDefault(u=>Json.Get(u,"id")==Json.Get(first,"upstreamId"));
                if(upstream!=null&&Json.Get(upstream,"kind")=="workbuddy"){var account=Json.Rows(config,"accounts").FirstOrDefault(a=>Json.Get(a,"id")==Json.Get(upstream,"accountId"));string key=(account==null?"cn":Json.Get(account,"edition","cn"))+"/"+Json.Get(first,"model");if(!displayedWb.Add(key))continue;}
                int row=routes.Rows.Add(Json.Get(route,"id"),Json.Get(route,"name",Json.Get(route,"id")),"已启用",string.Join(" → ",Json.Rows(route,"targets").Select(t=>Json.Get(t,"upstreamId")+": "+Json.Get(t,"model"))));routes.Rows[row].Tag=route;
            }
            if(section=="records")await LoadRecords();
            if(section=="routes")await LoadAuditStatuses();
            if(section=="diagnostics")await activityBoard.LoadAsync();
            if(section=="workbuddy")await wbBoard.LoadAsync();
            if(section=="updates")await clientUpdatesBoard.LoadAsync();
            if(section=="operations")await operationsBoard.LoadAsync();
            status.Text="已连接 "+Backend.BaseUrl+" · 正式管理工具";
        }
        internal static async Task<MainWindow> OpenProductionToolAsync(string configFile,string section,Form owner) {
            if(!File.Exists(configFile))throw new FileNotFoundException("现有网关配置未找到。");
            var backend=new Gateway(configFile);MainWindow form=null;
            try {
                form=new MainWindow(backend,false,false,true);form.PrepareProductionTool(section);
                await form.LoadProductionToolAsync(section);
                form.Disposed+=(s,e)=>backend.Dispose();form.Show(owner);form.Activate();return form;
            } catch {if(form!=null)form.Dispose();backend.Dispose();throw;}
        }
        internal static object ProductionToolsContract(string configFile) {
            var reports=new List<object>();int passed=0;
            foreach(string section in ProductionSections)using(var backend=new Gateway(configFile))using(var form=new MainWindow(backend,false,false,true)) {
                form.PrepareProductionTool(section);var pending=new Stack<Control>();pending.Push(form);int controls=0,buttons=0;
                while(pending.Count>0){var current=pending.Pop();controls++;if(current is Button)buttons++;foreach(Control child in current.Controls)pending.Push(child);}
                bool ok=form.Controls.Count==2&&form.Controls[0] is Panel&&controls>2&&buttons>2&&!form.tray.Visible&&!form.refreshTimer.Enabled&&form.quit;
                if(ok)passed++;reports.Add(new {section=section,ok=ok,controls=controls,buttons=buttons,title=form.Text,oldOverviewVisible=false,backgroundStarted=false,networkRequests=0});
            }
            return new {passed=passed,failed=ProductionSections.Length-passed,tools=reports};
        }
        internal void FinishSelfTest() { if(balanceTransition!=null)balanceTransition.Dispose();if(routesTransition!=null)routesTransition.Dispose();quit = true; Close(); }
        private Panel Page(string title) { var p = new Panel { Text=title, BackColor = Theme.Background, Padding = new Padding(Theme.Padding) }; tabs.AddPage(p); return p; }
        private FlowLayoutPanel Toolbar(Panel p, int height = 56, bool adaptive = false) { var b = new FlowLayoutPanel { Dock = DockStyle.Top, Height = height,BackColor=Theme.Background }; if(adaptive){b.AutoSize=true;b.AutoSizeMode=AutoSizeMode.GrowAndShrink;b.MinimumSize=new Size(0,height);b.Padding=new Padding(0,0,0,8);} p.Controls.Add(b); return b; }
        private void AddButton(FlowLayoutPanel p, string text, Func<Task> action) { var b = Theme.Button(text); b.Click += async (s, e) => { b.Enabled = false; try { await Run(action); } finally { b.Enabled = true; UpdateAuditControls(); } }; p.Controls.Add(b); }
        private async Task Run(Func<Task> action) { if (busy != 0) { status.Text = "上一项操作正在执行，请稍候"; return; } busy++; bool failed=false; status.Text = "正在处理…（界面可继续浏览）"; try { await action(); } catch (Exception e) { failed=true; ShowError(e); } finally { busy--; if(!failed&&(status.Text.StartsWith("正在处理")||status.Text.StartsWith("上一项操作")))status.Text="操作完成 · "+DateTime.Now.ToString("HH:mm:ss"); } }
        private async Task ClaimAllAccounts(){await Backend.Connect(false);var result=await Backend.Request("POST","/admin/claim",new object());details.Text=Json.Pretty(result);await LoadRecords();await LoadBalances(true);var rows=Json.Rows(result,"results").ToArray();int ok=rows.Count(r=>new[]{"success","already","observed"}.Contains(Json.Get(r,"status")));status.Text="签到检查完成："+ok+" / "+rows.Length+" 项；其他结果见领取记录";}
        internal async Task TestOperationLifecycle(){await Run(()=>Task.FromResult(0));if(busy!=0||status.Text.StartsWith("正在处理"))throw new Exception("Busy lifecycle did not complete");await Run(()=>{throw new Exception("FIXTURE_FAILURE");});if(busy!=0||!status.Text.StartsWith("操作失败"))throw new Exception("Failure status lost");await Run(()=>Task.FromResult(0));}
        private void ShowError(Exception e) { status.Text = "操作失败：" + e.Message; details.Text = e.Message; }
        private WbPoolBoard wbBoard;
        private ClientUpdatesBoard clientUpdatesBoard;
        private void BuildOperations(){var p=Page("运行中心");p.Padding=Padding.Empty;operationsBoard=new OperationsBoard(Backend){Dock=DockStyle.Fill};operationsBoard.AccountRequested+=async id=>{tabs.SelectedIndex=6;await wbBoard.BrowseAccountAsync(id);};operationsBoard.NotificationRaised+=row=>{if(!IsDisposed)tray.ShowBalloonTip(5000,Json.Get(row,"title","AI网关提醒"),Json.Get(row,"message"),Json.Get(row,"severity")=="error"?ToolTipIcon.Error:ToolTipIcon.Info);};p.Controls.Add(operationsBoard);}
        private void BuildClientUpdates(){var p=Page("软件更新");p.Padding=Padding.Empty;clientUpdatesBoard=new ClientUpdatesBoard(Backend){Dock=DockStyle.Fill};p.Controls.Add(clientUpdatesBoard);}
        private void BuildWorkBuddy(){var p=Page("wb帐号池");p.Padding=Padding.Empty;wbBoard=new WbPoolBoard(Backend,LoadAll){Dock=DockStyle.Fill};p.Controls.Add(wbBoard);}
        private void BuildActivity(){var p=Page("请求诊断台");p.Padding=Padding.Empty;activityBoard=new DiagnosticsWorkspace(Backend){Dock=DockStyle.Fill};p.Controls.Add(activityBoard);}
        private void BuildOverview() { var p = Page("积分中心"); p.Controls.Add(overviewHost); overviewHost.Controls.Add(creditCards); overviewHost.Controls.Add(summary); creditCards.SizeChanged += (s,e) => ResizeCards(); overviewHost.ScrollMoved += (s,e) => RememberAnchor(); }
        // 滚动锚点：以账号 ID + 该卡顶部偏移为锚，布局变化/刷新后仍能回到同一条目。
        internal ScrollAnchor CaptureAnchor() {
            if(overviewHost.VerticalScroll.Value<=0)return new ScrollAnchor();
            int y=overviewHost.VerticalScroll.Value;
            CreditCard best=null;int bestDelta=int.MaxValue;
            foreach(Control control in creditCards.Controls){var card=control as CreditCard;if(card==null)continue;int delta=card.Top-y;if(delta<=6&&-delta<bestDelta){bestDelta=-delta;best=card;}}
            if(best==null)return new ScrollAnchor();
            return new ScrollAnchor {Id=best.AccountKey,Offset=y-best.Top};
        }
        internal void ApplyAnchor(ScrollAnchor value) {
            if(!value.Known)return;
            Control target=null;foreach(Control control in creditCards.Controls){var card=control as CreditCard;if(card!=null&&card.AccountKey==value.Id){target=card;break;}}
            if(target==null)return;
            int wanted=Math.Max(0,target.Top+value.Offset);
            int limit=Math.Max(0,overviewHost.DisplayRectangle.Height-overviewHost.ClientSize.Height);
            restoringAnchor=true;try{overviewHost.AutoScrollPosition=new Point(0,Math.Min(wanted,limit));}finally{restoringAnchor=false;}
        }
        internal void RememberAnchor(){if(!restoringAnchor)anchor=CaptureAnchor();}

        internal void ResizeCards() {float scale=UiMetrics.Scale(creditCards);int gap=(int)(UiMetrics.CardGap*scale);int minWidth=(int)(UiMetrics.CardMinWidth*scale);int floor=(int)(200*scale);int avail=Math.Max(floor,creditCards.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-4);int cols=Math.Max(1,Math.Min(3,avail/minWidth));cardColumns=cols;int w=Math.Max(floor,avail/cols-gap);if(w>creditCards.ClientSize.Width-4&&creditCards.ClientSize.Width>4)w=creditCards.ClientSize.Width-4;int desired=(int)(4*scale);var cards=creditCards.Controls.Cast<Control>().ToArray();for(int start=0;start<cards.Length;start+=cols){var row=cards.Skip(start).Take(cols).ToArray();int rowHeight=0;foreach(Control card in row){var credit=card as CreditCard;int h=(int)((credit==null?UiMetrics.CardHeight:credit.PreferredHeight)*scale);card.Margin=new Padding(0,0,gap,gap);card.Size=new Size(w,h);rowHeight=Math.Max(rowHeight,h);}desired+=rowHeight+gap;}if(creditCards.Height!=desired)creditCards.Height=desired;}
        internal int CardColumns {get{return cardColumns;}}
        private string lastBalances = "";private SurfaceTransition balanceTransition;
        private async Task LoadBalances(bool force=false) {
            var result=await Backend.Request("GET","/admin/balances"+(force?"?refresh=1":""));string snapshot=Json.Text(result);if(!force&&snapshot==lastBalances){foreach(Control card in creditCards.Controls)card.Invalidate();return;}
            if(!force)RememberAnchor();else anchor=CaptureAnchor();
            lastBalances=snapshot;var data=Json.Rows(result,"accounts").Where(a=>WbPoolUi.ShowInOverview(a)).OrderBy(a=>Json.Get(a,"platform")=="opencode"?0:1).ToArray();
            // 数组项复用：同 accountId 的卡片就地更新内容，避免重建丢失滚动位置与焦点。
            bool reuse=data.Length==creditCards.Controls.Count;
            if(reuse)foreach(var a in data){if(!creditCards.Controls.Cast<CreditCard>().Any(c=>c.AccountKey==Json.Get(a,"accountId",Json.Get(a,"label","card")))){reuse=false;break;}}
            if(!reuse){if(balanceTransition==null)balanceTransition=new SurfaceTransition(tabs.Panels[0]);balanceTransition.Capture(overviewHost);}
            creditCards.SuspendLayout();
            if(reuse){int index=0;foreach(var a in data){var card=creditCards.Controls.Cast<CreditCard>().First(c=>c.AccountKey==Json.Get(a,"accountId",Json.Get(a,"label","card")));card.RefreshContent(a);creditCards.Controls.SetChildIndex(card,index++);}}
            else{
                List<CreditCard> pool=new List<CreditCard>();foreach(Control control in creditCards.Controls.Cast<Control>().ToArray()){var card=control as CreditCard;if(card!=null&&!data.Any(a=>Json.Get(a,"accountId",Json.Get(a,"label","card"))==card.AccountKey))card.Dispose();else if(card!=null)pool.Add(card);}
                creditCards.Controls.Clear();
                foreach(var a in data){string key=Json.Get(a,"accountId",Json.Get(a,"label","card"));CreditCard existing=pool.FirstOrDefault(c=>c.AccountKey==key);
                    if(existing!=null){pool.Remove(existing);existing.RefreshContent(a);creditCards.Controls.Add(existing);continue;}
                    var fresh=new CreditCard(a,UiMetrics.PlatformColor(Json.Get(a,"platform")),()=>RunRefresh(),()=>ShowBalanceDetails(a));creditCards.Controls.Add(fresh);
                }
                foreach(var leftover in pool)leftover.Dispose();
            }
            balanceCardCount=data.Length;summary.Platforms=data.Length;summary.Verified=data.Count(a=>!a.ContainsKey("error")&&!object.Equals(a.ContainsKey("stale")?a["stale"]:false,true));summary.Routes=routes.Rows.Count;summary.Invalidate();ResizeCards();creditCards.ResumeLayout();
            ApplyAnchor(anchor);if(!reuse&&balanceTransition!=null)balanceTransition.Play(overviewHost);
            // The forced balance query has already contacted providers. Re-read only the shared WB cache;
            // never repeat an upstream refresh or query task state just to update the visible daily badge.
            if(force&&wbBoard!=null&&!IsDisposed){
                try{await wbBoard.LoadAsync(false);bool attention;string receipt=WbPoolUi.BalanceRefreshReceipt(result,wbBoard.LastSummary,out attention);status.Text=WbPoolUi.BalanceRefreshStatus(result,wbBoard.LastSummary);status.AccessibleDescription=receipt;wbBoard.PresentBalanceRefreshReceipt(receipt,attention);}
                catch(Exception error){status.Text="余额已返 · WB签到同步失败";status.AccessibleDescription="余额结果已返回；WB今日签到明细同步失败："+error.Message+"；原账号页保留，请刷新重试";}
            }
        }
        private async void RunRefresh(){await Run(async()=>await LoadBalances(true));}
        private void ShowBalanceDetails(Dictionary<string,object> a){using(var d=new UsageDetailsForm(Backend,a))d.ShowDialog(this);}

        private async Task CaptureWorkBuddyAccount() {
            using(var d=new JsonDialog("保存当前 WorkBuddy 登录为独立账号",new Dictionary<string,object>{{"id","workbuddy-"+DateTime.Now.ToString("MMddHHmmss")},{"label","WorkBuddy 新账号"}})) {
                if(d.ShowDialog(this)!=DialogResult.OK)return;
                details.Text=Json.Pretty(await Backend.Request("POST","/admin/workbuddy/capture",d.Value));await LoadAll();
                status.Text="账号登录态已隔离保存；同一账号自动合并。可在 WorkBuddy 登录下一个账号后再次保存";
            }
        }
        private async Task WorkBuddyAccountPool() {
            string id=Selected(routes);var route=Json.Rows(config,"routes").First(r=>Json.Get(r,"id")==id);
            var target=Json.Rows(route,"targets").First();var upstream=Json.Rows(config,"upstreams").First(u=>Json.Get(u,"id")==Json.Get(target,"upstreamId"));
            if(Json.Get(upstream,"kind")!="workbuddy")throw new Exception("请先选中一个 WorkBuddy 模型路由。");
            var members=Json.Rows(config,"accounts").Where(a=>Json.Get(a,"platform")=="workbuddy"&&Json.Enabled(a)).ToArray();
            var pool=route.ContainsKey("accountPool")?route["accountPool"] as Dictionary<string,object>:null;
            var selected=pool!=null&&pool.ContainsKey("accountIds")?((System.Collections.IEnumerable)pool["accountIds"]).Cast<object>().Select(Convert.ToString).ToArray():new string[0];
            using(var d=new ProductForm {Text="WorkBuddy 账号池 · "+Json.Get(route,"name",id),Size=new Size(740,560),MinimumSize=new Size(680,500),StartPosition=FormStartPosition.CenterParent,BackColor=Theme.Background,Font=Theme.Body,Padding=new Padding(24)}) {
                var stack=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true};
                var enable=new CheckBox {Text="启用额度耗尽自动切换（优先顺序；不是轮询）",Checked=pool!=null&&Json.Enabled(pool),AutoSize=true,ForeColor=Theme.Ink};stack.Controls.Add(enable);
                var list=new CheckedListBox {Width=650,Height=180,CheckOnClick=true,BackColor=Theme.Surface,ForeColor=Theme.Ink,BorderStyle=BorderStyle.None};
                for(int i=0;i<members.Length;i++)list.Items.Add(Json.Get(members[i],"label")+" / "+Json.Get(members[i],"id"),selected.Contains(Json.Get(members[i],"id")));stack.Controls.Add(list);
                var choose=new ComboBox {Width=650,DropDownStyle=ComboBoxStyle.DropDownList};foreach(var a in members)choose.Items.Add(Json.Get(a,"label")+" / "+Json.Get(a,"id"));if(members.Length>0)choose.SelectedIndex=0;stack.Controls.Add(choose);
                var hint=new Label {Text="已输出的流不会从头重放；切换账号保留同一模型、工具和会话内容。",AutoSize=true,MaximumSize=new Size(650,0),ForeColor=Theme.Muted};stack.Controls.Add(hint);
                var buttons=new FlowLayoutPanel {Width=650,Height=60};var save=Theme.Button("保存账号池");var change=Theme.Button("立即切换所选账号");buttons.Controls.Add(save);buttons.Controls.Add(change);stack.Controls.Add(buttons);
                var output=Theme.Output();output.Dock=DockStyle.None;output.Width=650;output.Height=100;stack.Controls.Add(output);
                save.Click+=async(s,e)=>{save.Enabled=false;try{var ids=list.CheckedIndices.Cast<int>().Select(i=>Json.Get(members[i],"id")).ToArray();output.Text=Json.Pretty(await Backend.Request("POST","/admin/workbuddy/pool",new {routeId=id,accountIds=ids,enabled=enable.Checked,cooldownSeconds=3600}));await LoadAll();hint.Text="账号池已保存；DSH配置约30秒内同步。";}catch(Exception x){hint.Text=x.Message;}finally{save.Enabled=true;}};
                change.Click+=async(s,e)=>{change.Enabled=false;try{if(choose.SelectedIndex<0)throw new Exception("先添加并启用 WorkBuddy 账号。");output.Text=Json.Pretty(await Backend.Request("POST","/admin/workbuddy/switch",new {routeId=id,accountId=Json.Get(members[choose.SelectedIndex],"id")}));hint.Text="所选账号将在下一次请求优先使用；当前已输出的请求保持原账号。";}catch(Exception x){hint.Text=x.Message;}finally{change.Enabled=true;}};
                d.Controls.Add(stack);d.ShowDialog(this);
            }
        }
        private void BuildAccounts() {
            var p = Page("账号与领取"); var split = new SplitContainer { Size = new Size(1000, 500), Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, FixedPanel = FixedPanel.Panel2, SplitterDistance = 325 }; split.Panel1.Controls.Add(accounts); split.Panel2.Controls.Add(details); p.Controls.Add(split); var b = Toolbar(p, 100, true);
            AddButton(b,"保存当前WorkBuddy账号",CaptureWorkBuddyAccount);
            AddButton(b, "读取登录态", async () => { details.Text = Json.Pretty(await Backend.Request("POST", "/admin/doctor", new object())); });
            AddButton(b, "服务端体检", async () => { details.Text = Json.Pretty(await Backend.Request("POST", "/admin/health", new { accountId = Selected(accounts) })); });
            AddButton(b, "领取所选账号", async () => { string id = Selected(accounts); var a = Json.Rows(config, "accounts").First(x => Json.Get(x, "id") == id); var tasks = Json.Rows(a, "tasks").Where(Json.Enabled).ToArray(); if (tasks.Length == 0) throw new Exception("这个账号没有启用领取任务。"); var results = new List<object>(); foreach (var t in tasks) results.Add(await Backend.Request("POST", "/admin/claim", new { accountId = id, taskId = Json.Get(t, "id") })); details.Text = Json.Pretty(results); await LoadRecords(); });
            AddButton(b, "启用 / 停用整个账号", async () => { var a = Json.Rows(config, "accounts").First(x => Json.Get(x, "id") == Selected(accounts)); if(MessageBox.Show(this,"此开关同时影响该账号的调用、自动签到和自动任务。若仅暂停 WB 积分调用，请在 wb帐号池操作；签到和任务将保持不变。继续？","整个账号开关",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.Yes)return; a["enabled"] = !Json.Enabled(a); await Save(); });
            AddButton(b, "编辑账号", () => Edit("accounts", Selected(accounts), "编辑账号与凭据文件引用"));
            AddButton(b, "新增账号", () => Edit("accounts", null, "新增账号", new Dictionary<string, object> { {"id", "ACCOUNT"}, {"label", "新账号"}, {"platform", "workbuddy"}, {"enabled", false}, {"credentials", new Dictionary<string, object> { {"kind", "desktop"}, {"file", "auto"} }}, {"tasks", new object[] { new Dictionary<string, object> { {"id", "daily-checkin"}, {"enabled", true} } } } }));
            AddButton(b,"添加平台账号",AddPlatformAccount);
            AddButton(b, "添加 NVIDIA API", () => Edit("accounts", null, "添加 NVIDIA 官方 API · 只填本机文件引用", NvidiaPresentation.NewAccount()));
            AddButton(b, "删除账号", async () => { string id = Selected(accounts); if (MessageBox.Show(this, "删除账号配置 " + id + "？引用将一并清理，聊天与历史记录保留；私密凭据保留可回滚备份。", "删除账号", MessageBoxButtons.YesNo) != DialogResult.Yes) return; details.Text=Json.Pretty(await Backend.Request("DELETE","/admin/accounts/"+Uri.EscapeDataString(id),new {confirm=true}));await LoadAll(); });
        }
        private void BuildRoutes() {
            var p=Page("模型与路由");p.Controls.Add(routes);RouteAuditSelection.Configure(routes);routes.CellValueChanged+=(sender,args)=>UpdateAuditControls();var b=Toolbar(p,56,true);
            AddButton(b,"全选",()=>{RouteAuditSelection.SelectAll(routes,true);return Task.FromResult(0);});AddButton(b,"清空",()=>{RouteAuditSelection.SelectAll(routes,false);return Task.FromResult(0);});
            AddButton(b,"测试选中模型",TestSelectedRoutes);selectedAuditButton=b.Controls.OfType<Button>().Last();b.Controls.Add(routeSelectionCount);
            AddButton(b,"取消导入 / 停用所选路由",ExportSelectedRoutes);exportSelectedButton=b.Controls.OfType<Button>().Last();
            AddButton(b,"路由预演",PreviewRoute);AddButton(b,"路由优先级",EditRouteTargets);AddButton(b,"高级路由 JSON",()=>Edit("routes",Selected(routes),"高级路由编辑 · targets 按优先级排列"));
            AddButton(b,"同模型自动接力",ModelRelaySettings);AddButton(b,"免费平台入口",FreeProviderSetup);AddButton(b,"WorkBuddy账号池",WorkBuddyAccountPool);AddButton(b,"全部模型 / 选择导入",ModelDirectory);
            AddButton(b,"刷新目录",RefreshDirectory);AddButton(b,"体检已导入模型",RefreshImportedModels);
            AddButton(b,"测试全部模型",async()=>{await StartAudit(new Dictionary<string,object>{{"scope","all"}});});
            AddButton(b,"重启 DSH",async()=>{if(MessageBox.Show(this,"将退出并重新打开 DSH，正在运行的任务会中断。继续？","重启 DSH",MessageBoxButtons.YesNo)!=DialogResult.Yes)return;await Backend.Request("POST","/admin/restart-dsh",new object());status.Text="重启动作已提交；当前进程加载与客户端验收请到请求诊断台分别核对";});
            AddButton(b,"上游设置",async()=>{using(var d=new JsonDialog("上游列表；凭据仅填写本机文件引用",new Dictionary<string,object>{{"upstreams",config["upstreams"]}})){if(d.ShowDialog(this)==DialogResult.OK){config["upstreams"]=d.Value["upstreams"];await Save();}}});
            auditButtons.AddRange(b.Controls.OfType<Button>().Where(x=>!new[]{"重启 DSH","路由预演"}.Contains(x.Text)));UpdateAuditControls();
        }
        private Task PreviewRoute(){string selected=routes.CurrentRow==null?"":Convert.ToString(routes.CurrentRow.Cells[0].Value);using(var dialog=new RoutePreviewForm(Backend,config,selected))dialog.ShowDialog(this);return Task.FromResult(0);}
        private async Task EditRouteTargets(){string id=Selected(routes);var route=Json.Rows(config,"routes").First(r=>Json.Get(r,"id")==id);using(var dialog=new RouteTargetsForm(route)){if(dialog.ShowDialog(this)!=DialogResult.OK)return;await SaveTargetsOrder(id,dialog.OriginalTargets,dialog.Targets);}}
        internal async Task SaveTargetsOrder(string id,Dictionary<string,object>[] expected,Dictionary<string,object>[] targets){
            var result=await Backend.Request("POST","/admin/routes/"+Uri.EscapeDataString(id)+"/targets-order",new{expectedTargets=expected,targets=targets});
            if(!object.Equals(result.ContainsKey("saved")?result["saved"]:false,true)||Json.Get(result,"routeId")!=id||Json.Text(Json.Rows(result,"targets").ToArray())!=Json.Text(targets))throw new InvalidOperationException("后台未精确确认目标顺序；原配置保留，请刷新后重新核对。");
            await LoadAll();status.Text="路由优先级已保存；只调整本路由顺序，其他账号、路由与目标字段保持不变";
        }
        private async Task ModelRelaySettings(){var data=await Backend.Request("GET","/admin/model-relay");using(var d=new ModelRelayForm(Backend,data))if(d.ShowDialog(this)==DialogResult.OK)await LoadAll();}
        private async Task FreeProviderSetup(){var data=await Backend.Request("GET","/admin/free-providers");using(var d=new FreeProviderForm(Backend,data))if(d.ShowDialog(this)==DialogResult.OK)await LoadAll();}
        private static string AuditName(Dictionary<string,object> r){if(r==null)return "未测试";if(Json.Get(r,"capabilityStatus")=="chat_only")return "聊天通过 / 工具未声明";string state=Json.Get(r,"status");return state=="passed"?"全部通过":state=="failed"?"未通过":state=="partial"?"仅聊天 / 工具未通过":state=="uncertain"?"待复测":state=="unavailable"?"当前通道未提供":"检测中";}
        private bool watchingAudit,auditRunning,auditSubmitting;internal Func<string,bool> AuditConfirmation;
        private Button selectedAuditButton,exportSelectedButton;private SurfaceTransition routesTransition;internal Func<string,int,string[],bool> ExportConfirmation;
        private readonly List<Button> auditButtons=new List<Button>();
        private readonly Label routeSelectionCount=new Label {AutoSize=true,Text="已选 0 个路由",ForeColor=Theme.Muted,Margin=new Padding(8,15,8,8)};
        private void UpdateAuditControls(){if(!routes.Columns.Contains(RouteAuditSelection.Column))return;int count=routes.Rows.Cast<DataGridViewRow>().Count(r=>object.Equals(r.Cells[RouteAuditSelection.Column].Value,true));routeSelectionCount.Text="已选 "+count+" 个路由"+(auditRunning?" · 检测中":"");foreach(var button in auditButtons)button.Enabled=!auditRunning&&!auditSubmitting;if(selectedAuditButton!=null)selectedAuditButton.Enabled=count>0&&!auditRunning&&!auditSubmitting;if(exportSelectedButton!=null)exportSelectedButton.Enabled=count>0&&!auditRunning&&!auditSubmitting;routes.Columns[RouteAuditSelection.Column].ReadOnly=auditRunning||auditSubmitting;}
        internal string[] SelectedRouteIds(){return RouteAuditSelection.Ids(routes);}
        internal string[] LocalRouteIds(){return Json.Rows(config,"routes").Select(r=>Json.Get(r,"id")).Where(id=>id.Length>0).ToArray();}
        internal bool ExportSelectedButtonEnabled(){return exportSelectedButton!=null&&exportSelectedButton.Enabled;}
        // 导出选中模型＝取消导入并停用勾选路由（不是导出 JSON）：只对本次确认过的 routeIds 生效，未选路由与已有 targets 一律保持原样。
        private Task ExportSelectedRoutes(){return ExportSelectedRoutes(null);}
        internal async Task ExportSelectedRoutes(string capture){
            if(auditRunning||auditSubmitting)throw new InvalidOperationException("模型操作正在执行，请等待本轮结束");
            var ids=SelectedRouteIds();
            if(ids.Length==0)throw new InvalidOperationException("请至少勾选一个已导入路由；空选不提交请求");
            string question="将取消导入并停用这 "+ids.Length+" 个路由："+Environment.NewLine+string.Join("、",ids)+Environment.NewLine+Environment.NewLine+"保留 targets、配置与体检历史，未勾选路由保持不变。这不是导出文件。继续？";
            bool confirmed=ExportConfirmation!=null?ExportConfirmation(question,ids.Length,ids):MessageBox.Show(this,question,"取消导入 / 停用所选路由",MessageBoxButtons.YesNo,MessageBoxIcon.Warning,MessageBoxDefaultButton.Button2)==DialogResult.Yes;
            if(!confirmed)return;
            auditSubmitting=true;UpdateAuditControls();bool ok=false;bool captured=false;
            try{
                var result=await Backend.Request("POST","/admin/model-export",new Dictionary<string,object>{{"routeIds",ids}});
                var returned=Json.Strings(result,"disabledRouteIds");
                if(!object.Equals(result.ContainsKey("saved")?result["saved"]:false,true)||returned.Length!=ids.Length||!new HashSet<string>(returned).SetEquals(ids))throw new Exception("后台未精确确认所选路由，保持现有勾选与列表，请重新核验");
                if(routesTransition==null)routesTransition=new SurfaceTransition(tabs.Panels[2]);captured=routesTransition.Capture(routes);
                var selected=new HashSet<string>(ids);
                foreach(var route in Json.Rows(config,"routes"))if(selected.Contains(Json.Get(route,"id")))route["enabled"]=false;
                // 同步高级编辑器的相同字段，保留用户尚未保存的其它编辑，避免后续保存复活路由。
                try{var draft=Json.Object(editor.Text);foreach(var route in Json.Rows(draft,"routes"))if(selected.Contains(Json.Get(route,"id")))route["enabled"]=false;editor.Text=Json.Pretty(draft);}catch{editor.Text=Json.Pretty(config);}
                for(int i=routes.Rows.Count-1;i>=0;i--){var tag=routes.Rows[i].Tag as Dictionary<string,object>;if(tag!=null&&selected.Contains(Json.Get(tag,"id")))routes.Rows.RemoveAt(i);}
                summary.Routes=routes.Rows.Count;summary.Invalidate();settingsBoard.Invalidate();
                if(captured)routesTransition.Play(routes);ok=true;
                status.Text="已取消导入 "+ids.Length+" 个路由 · 本次停用 "+Json.Get(result,"disabled","?")+" · 原已停用 "+Json.Get(result,"alreadyDisabled","0")+"；配置与历史保留";
            }finally{if(!ok&&routesTransition!=null)routesTransition.Cancel();auditSubmitting=false;UpdateAuditControls();
                if(capture!=null)File.WriteAllText(capture,Json.Text(new{requestedRouteIds=ids,saved=ok,remainingRoutes=routes.Rows.Count}),new UTF8Encoding(false));}
        }
        internal async Task<bool> SaveDirectorySelection(DataGridView grid){
            var items=ModelDirectoryView.Changes(grid);if(items.Count==0)return false;
            await Backend.Request("POST","/admin/model-import",new {items=items});return true;
        }
        private async Task StartAudit(Dictionary<string,object> body){
            if(auditRunning||auditSubmitting)throw new InvalidOperationException("模型体检正在执行，请等待本轮结束");
            string scope=Json.Get(body,"scope"),name=scope=="selected"?"选中路由":scope=="imported"?"已导入模型":"全部平台模型";int count=scope=="selected"?Json.Strings(body,"routeIds").Length:Json.Rows(config,"routes").Count(Json.Enabled);
            string question="范围："+name+(scope=="all"?"（实际数量以当前目录为准）":" · 当前配置 "+count+" 个启用路由")+"\n"+"阶段：普通 / 流式 / 工具 / 回传，共 4 阶段。"+"\n"+"这将发送真实生成请求并可能消耗积分。单阶段可能等待数分钟，总耗时取决于目录规模、上游响应与限流；后台显示阶段与进度。继续？";
            if(!(AuditConfirmation!=null?AuditConfirmation(question):MessageBox.Show(this,question,"确认模型体检范围与耗时",MessageBoxButtons.YesNo,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)==DialogResult.Yes)){status.Text="已取消体检，未提交生成请求";return;}
            auditSubmitting=true;UpdateAuditControls();try{var audit=await Backend.Request("POST","/admin/model-tests",body);auditRunning=Json.Get(audit,"status")=="running";watchingAudit=true;await LoadAuditStatuses();}finally{auditSubmitting=false;UpdateAuditControls();}
        }
        private async Task TestSelectedRoutes(){await StartAudit(RouteAuditSelection.Body(routes));}
        private async Task RefreshDirectory(){var result=await Backend.Request("GET","/admin/model-directory");status.Text="目录已读取："+Json.Rows(result,"providers").Count()+" 个平台 · 未执行模型体检，未改变导入选择";}
        private async Task RefreshImportedModels(){await StartAudit(new Dictionary<string,object>{{"scope","imported"}});}
        private async Task LoadAuditStatuses(){
            var audit=await Backend.Request("GET","/admin/model-tests");var tested=Json.Rows(audit,"results").ToArray();
            foreach(DataGridViewRow row in routes.Rows){var r=row.Tag as Dictionary<string,object>;if(r==null)continue;var t=Json.Rows(r,"targets").FirstOrDefault();if(t==null)continue;var found=tested.FirstOrDefault(x=>Json.Get(x,"upstreamId")==Json.Get(t,"upstreamId")&&Json.Get(x,"model")==Json.Get(t,"model"));row.Cells[2].Value="已启用 · "+AuditName(found);row.Cells[2].ToolTipText=found==null?"尚未测试":Json.Get(found,"reason")+"\n最近测试："+Json.Get(found,"finishedAt",Json.Get(found,"startedAt","本轮排队中"));row.Cells[2].Style.ForeColor=found!=null&&Json.Get(found,"status")=="passed"?Theme.Success:Theme.Warning;}
            string scope=Json.Get(audit,"scope")=="selected"?"选中路由":Json.Get(audit,"scope")=="imported"?"已导入模型":"全部模型",state=Json.Get(audit,"status");auditRunning=state=="running";UpdateAuditControls();
            if(state=="running"){watchingAudit=true;status.Text=scope+"体检："+Json.Get(audit,"completed")+" / "+Json.Get(audit,"total")+(Json.Get(audit,"queuedScope")=="imported"?" · 已导入模型体检已排队":" · 普通 / 流式 / 工具 / 回传");}
            else if(watchingAudit){watchingAudit=false;var counts=audit.ContainsKey("summary")?audit["summary"] as Dictionary<string,object>:null;status.Text=state=="completed"?scope+"体检完成："+Json.Get(audit,"completed")+" / "+Json.Get(audit,"total")+"；全部通过 "+(counts==null?"0":Json.Get(counts,"passed","0"))+"，其他结果见状态列及悬停详情":"模型体检中断，请查看结果后重试";}
        }
        private Task ModelDirectory() { return ModelDirectory(null); }
        internal Task ModelDirectory(string capture) {
            using(var dialog=new ProductForm {Text="全部平台模型 · 勾选导入 DSH",Size=new Size(1280,800),MinimumSize=new Size(1060,640),StartPosition=FormStartPosition.CenterParent,BackColor=Theme.Background,Font=Theme.Body,Padding=new Padding(24)})
            using(var filterTimer=new System.Windows.Forms.Timer {Interval=120}) {
                var grid=ModelDirectoryView.Create();
                var top=new FlowLayoutPanel {Dock=DockStyle.Top,Height=72};var search=new TextBox {Width=300,Font=Theme.Body};var platform=new ComboBox {Width=170,DropDownStyle=ComboBoxStyle.DropDownList};platform.Items.Add("全部平台");platform.SelectedIndex=0;
                top.Controls.Add(new Label {Text="筛选模型",AutoSize=true,ForeColor=Theme.Ink,Padding=new Padding(0,5,12,0)});top.Controls.Add(search);top.Controls.Add(platform);var category=new ComboBox {Width=130,DropDownStyle=ComboBoxStyle.DropDownList};category.Items.AddRange(new object[]{"全部类型","聊天","向量","重排","图像","音频","视频","视觉","其他","待分类"});category.SelectedIndex=0;top.Controls.Add(category);
                var footer=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=108};var save=Theme.Button("保存导入选择");save.BackColor=Theme.Accent;save.ForeColor=Color.White;var all=Theme.Button("勾选筛选结果");var none=Theme.Button("取消筛选结果");var hint=new Label {AutoSize=true,MaximumSize=new Size(880,0),ForeColor=Theme.Muted,Margin=new Padding(8,8,0,0)};footer.Controls.Add(save);footer.Controls.Add(all);footer.Controls.Add(none);footer.Controls.Add(hint);
                string catalogHint="正在读取模型目录；窗口可立即关闭，不执行模型体检。";bool loaded=false,loading=false;int count=0;var retry=Theme.Button("重试读取目录");retry.Visible=false;footer.Controls.Add(retry);
                grid.Enabled=false;save.Enabled=false;all.Enabled=false;none.Enabled=false;hint.Text=catalogHint;
                Action sync=()=>{if(dialog.IsDisposed||dialog.Disposing)return;int changes=ModelDirectoryView.ChangedCount(grid);hint.Text=loaded?"待保存 "+changes+" 项变更 · "+catalogHint:catalogHint;save.Enabled=loaded&&changes>0;};
                Action filter=()=>{filterTimer.Stop();if(!loaded||dialog.IsDisposed||dialog.Disposing)return;ModelDirectoryView.Filter(grid,platform.SelectedIndex==0?"":Convert.ToString(platform.SelectedItem),search.Text,category.SelectedIndex==0?"":Convert.ToString(category.SelectedItem));};
                filterTimer.Tick+=(s,e)=>filter();search.TextChanged+=(s,e)=>{filterTimer.Stop();filterTimer.Start();};platform.SelectedIndexChanged+=(s,e)=>filter();category.SelectedIndexChanged+=(s,e)=>filter();
                all.Click+=(s,e)=>{ModelDirectoryView.SelectVisible(grid,true);sync();};none.Click+=(s,e)=>{ModelDirectoryView.SelectVisible(grid,false);sync();};
                grid.CellValuePushed+=(s,e)=>{if(e.RowIndex>=0)sync();};
                save.Click+=async(s,e)=>{grid.EndEdit();save.Enabled=false;all.Enabled=false;none.Enabled=false;grid.Enabled=false;try{if(await SaveDirectorySelection(grid)){await LoadAll();status.Text="导入变更已保存；未改动模型保持原样，目录约 30 秒内同步";}if(!dialog.IsDisposed&&!dialog.Disposing)dialog.DialogResult=DialogResult.OK;}catch(Exception x){if(!dialog.IsDisposed&&!dialog.Disposing)hint.Text="保存失败，选择保留："+x.Message;}finally{if(!dialog.IsDisposed&&!dialog.Disposing){grid.Enabled=true;all.Enabled=true;none.Enabled=true;save.Enabled=ModelDirectoryView.ChangedCount(grid)>0;}}};
                dialog.Controls.Add(grid);dialog.Controls.Add(footer);dialog.Controls.Add(top);
                Func<Task> load=async()=>{if(loading||loaded||dialog.IsDisposed)return;loading=true;retry.Visible=false;catalogHint="正在读取模型目录；窗口可立即关闭，不执行模型体检。";sync();try{var result=await Backend.Request("GET","/admin/model-directory");if(dialog.IsDisposed||dialog.Disposing||!dialog.Visible)return;count=ModelDirectoryView.Populate(grid,result,platform);catalogHint=ModelDirectoryView.CatalogSummary(result)+"；国内 WorkBuddy 按模型合并；取消导入保留配置与历史；缺失项仅可取消。";loaded=true;grid.Enabled=true;all.Enabled=true;none.Enabled=true;filter();sync();if(capture!=null){using(var bitmap=new Bitmap(dialog.Width,dialog.Height)){dialog.DrawToBitmap(bitmap,new Rectangle(Point.Empty,dialog.Size));bitmap.Save(capture,System.Drawing.Imaging.ImageFormat.Png);}File.WriteAllText(capture+".json",Json.Text(new {modelCount=count,selected=ModelDirectoryView.SelectedCount(grid),checkboxColumn=grid.Columns[0] is DataGridViewCheckBoxColumn,virtualMode=grid.VirtualMode}),new UTF8Encoding(false));dialog.DialogResult=DialogResult.OK;}}catch(Exception x){if(!dialog.IsDisposed&&!dialog.Disposing&&dialog.Visible){catalogHint="目录读取失败："+x.Message;sync();retry.Visible=true;}}finally{loading=false;}};
                retry.Click+=async(s,e)=>await load();dialog.Shown+=async(s,e)=>await load();dialog.FormClosed+=(s,e)=>filterTimer.Stop();
                dialog.ShowDialog(this);
            }return Task.FromResult(0);
        }

        private void BuildRecords() { var p = Page("领取记录"); p.Controls.Add(records); var b = Toolbar(p); AddButton(b, "刷新领取记录", LoadRecords); records.CellDoubleClick += (s, e) => { if (e.RowIndex < 0) return; using (var d = new JsonDialog("领取详情", (Dictionary<string, object>)records.Rows[e.RowIndex].Tag)) d.ShowDialog(this); }; }
        private void BuildConfig() { var p = Page("配置"); editor.ReadOnly = false; editor.Visible=false;p.Controls.Add(editor);p.Controls.Add(settingsBoard); var b = Toolbar(p); AddButton(b,"高级配置",()=>{bool show=!editor.Visible;editor.Visible=show;settingsBoard.Visible=!show;return Task.FromResult(0);}); AddButton(b, "定时与平台设置", SchedulerSettings); AddButton(b, "保存配置", async () => { var proposed = Json.Object(editor.Text); var r = await Backend.Request("PUT", "/admin/config", proposed); await LoadAll(); if (object.Equals(r.ContainsKey("serverRestartRequired") ? r["serverRestartRequired"] : false, true)) status.Text = "配置已保存；停止并启动后台以应用监听设置"; }); AddButton(b, "重新载入", LoadAll); }
        private async Task SchedulerSettings() {
            var schedule=config["scheduler"] as Dictionary<string,object>;
            using(var d=new ProductForm { Text="自动领取 · 定时设置", Size=new Size(620,560),StartPosition=FormStartPosition.CenterParent,Font=Theme.Body,BackColor=Theme.Background,Padding=new Padding(24) }) {
                var stack=new FlowLayoutPanel { Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true };
                var enabled=new CheckBox { Text="定时签到 / 领取（不控制积分调用）",Checked=Json.Enabled(schedule),AutoSize=true,ForeColor=Theme.Ink,Margin=new Padding(0,12,0,20) };stack.Controls.Add(enabled);
                stack.Controls.Add(new Label { Text="每日执行时间（"+Json.Get(schedule,"timezone")+"）",AutoSize=true,ForeColor=Theme.Ink });
                var time=new DateTimePicker { Format=DateTimePickerFormat.Custom,CustomFormat="HH:mm",ShowUpDown=true,Width=230,Value=DateTime.Today.AddHours(Convert.ToInt32(schedule["hour"])).AddMinutes(Convert.ToInt32(schedule["minute"])),Margin=new Padding(0,8,0,20) };stack.Controls.Add(time);
                stack.Controls.Add(new Label { Text="随机延迟上限（秒）",AutoSize=true,ForeColor=Theme.Ink });var jitter=new NumericUpDown { Minimum=0,Maximum=86400,Value=Convert.ToDecimal(schedule["jitterSeconds"]),Width=230,Margin=new Padding(0,8,0,20) };stack.Controls.Add(jitter);
                var checks=new List<CheckBox>(); foreach(var a in Json.Rows(config,"accounts")){var cb=new CheckBox { Text=Json.Get(a,"label")+" · 整个账号（调用＋签到＋任务）",Checked=Json.Enabled(a),AutoSize=true,Tag=a,ForeColor=Theme.Ink,Margin=new Padding(0,6,0,6) };checks.Add(cb);stack.Controls.Add(cb);}
                var save=Theme.Button("保存设置");save.BackColor=Theme.Accent;save.ForeColor=Color.White;save.Click+=(x,e)=>d.DialogResult=DialogResult.OK;stack.Controls.Add(save);d.Controls.Add(stack);
                if(d.ShowDialog(this)!=DialogResult.OK)return; schedule["enabled"]=enabled.Checked;schedule["hour"]=time.Value.Hour;schedule["minute"]=time.Value.Minute;schedule["jitterSeconds"]=(int)jitter.Value;foreach(var cb in checks)((Dictionary<string,object>)cb.Tag)["enabled"]=cb.Checked;await Save();
            }
        }
        private string Selected(DataGridView grid) { if (grid.SelectedRows.Count == 0) throw new Exception("请先选择一行。"); return Convert.ToString(grid.SelectedRows[0].Cells[0].Value); }
        private async Task Edit(string field, string id, string title, Dictionary<string, object> initial = null) {
            var rows = Json.Rows(config, field).ToList(); var prior = id == null ? null : rows.First(x => Json.Get(x, "id") == id); var copy = Json.Object(Json.Text(initial ?? prior));
            using (var d = new JsonDialog(title, copy, field=="accounts"&&NvidiaPresentation.IsNvidia(copy)?NvidiaPresentation.CredentialHint:null)) { if (d.ShowDialog(this) != DialogResult.OK) return; if(field=="accounts")NvidiaPresentation.ValidateAccount(d.Value); if (prior != null) rows[rows.IndexOf(prior)] = d.Value; else rows.Add(d.Value); config[field] = rows.ToArray(); await Save(); }
        }
        private async Task AddPlatformAccount(){using(var dialog=new PlatformAccountDialog()){if(dialog.ShowDialog(this)!=DialogResult.OK)return;var rows=Json.Rows(config,"accounts").ToList();if(rows.Any(a=>Json.Get(a,"id")==Json.Get(dialog.Value,"id")))throw new InvalidOperationException("账号 ID 已存在，请使用不同 ID");rows.Add(dialog.Value);config["accounts"]=rows.ToArray();await Save();}}
        private async Task Save() { foreach(var account in Json.Rows(config,"accounts"))NvidiaPresentation.ValidateAccount(account); await Backend.Request("PUT", "/admin/config", config); await LoadAll(); status.Text = "配置已保存并生效"; }
        internal async Task LoadAll() {
            var selectedRouteIds=new HashSet<string>(RouteAuditSelection.Ids(routes));config = await Backend.Request("GET", "/admin/config"); settingsBoard.Config=config;settingsBoard.Api=Backend.BaseUrl;settingsBoard.Invalidate();editor.Text = Json.Pretty(config); accounts.Rows.Clear(); routes.Rows.Clear();
            foreach (var a in Json.Rows(config, "accounts")) accounts.Rows.Add(Json.Get(a, "id"), Json.Get(a, "label", Json.Get(a, "id")), Json.Get(a, "platform"), Json.Enabled(a) ? "已启用" : "已停用", string.Join("、", Json.Rows(a, "tasks").Where(Json.Enabled).Select(t => Json.Get(t, "id"))));
            var displayedWb=new HashSet<string>();foreach (var r in Json.Rows(config, "routes").Where(Json.Enabled)) {var first=Json.Rows(r,"targets").FirstOrDefault();var upstream=first==null?null:Json.Rows(config,"upstreams").FirstOrDefault(u=>Json.Get(u,"id")==Json.Get(first,"upstreamId"));if(upstream!=null&&Json.Get(upstream,"kind")=="workbuddy"){var account=Json.Rows(config,"accounts").FirstOrDefault(a=>Json.Get(a,"id")==Json.Get(upstream,"accountId"));string key=(account==null?"cn":Json.Get(account,"edition","cn"))+"/"+Json.Get(first,"model");if(!displayedWb.Add(key))continue;}int index=routes.Rows.Add(Json.Get(r, "id"), Json.Get(r, "name", Json.Get(r, "id")), "已启用", string.Join(" → ", Json.Rows(r, "targets").Select(t => Json.Get(t, "upstreamId") + ": " + Json.Get(t, "model"))));routes.Rows[index].Tag=r;routes.Rows[index].Cells[RouteAuditSelection.Column].Value=selectedRouteIds.Contains(Json.Get(r,"id"));}
            var state = await Backend.Request("GET", "/admin/state"); var schedule = config["scheduler"] as Dictionary<string, object>;
            summary.Schedule="每日 "+Json.Get(schedule,"hour")+":"+Json.Get(schedule,"minute").PadLeft(2,'0')+"  /  随机延迟 "+Json.Get(schedule,"jitterSeconds")+" 秒";
            summary.EnabledAccounts=Json.Rows(config,"accounts").Where(Json.Enabled).ToArray();
            if(tabs.SelectedIndex==0){await LoadBalances();await LoadRecords();}
            if(tabs.SelectedIndex==3)await LoadRecords(); if(tabs.SelectedIndex==6)await wbBoard.LoadAsync();if(tabs.SelectedIndex==8)await operationsBoard.LoadAsync(); status.Text = "已连接 " + Backend.BaseUrl + " · 原生桌面窗口"; await LoadAuditStatuses();
        }
        internal async Task LoadRecords() {
            var data = await Backend.Request("GET", "/admin/records?limit=100"); records.Rows.Clear();summary.History=Json.Rows(data,"records").ToArray();summary.Invalidate();
            foreach (var r in summary.History) { DateTimeOffset time; string display = DateTimeOffset.TryParse(Json.Get(r, "time"), out time) ? time.ToLocalTime().ToString("MM-dd HH:mm:ss") : Json.Get(r, "time"); int n = records.Rows.Add(display, Json.Get(r, "platform") + " / " + Json.Get(r, "account_id"), Json.Get(r, "task"), Json.Get(r, "status"), Json.Text(r.ContainsKey("result") ? r["result"] : null)); records.Rows[n].Tag = r; }
        }
        internal void CaptureModelPage(string path){int old=tabs.SelectedIndex;tabs.SelectedIndex=2;using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(Point.Empty,Size));bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);}tabs.SelectedIndex=old;}
        internal async Task MeasureModelRefresh(){int old=tabs.SelectedIndex;tabs.SelectedIndex=2;var watch=Stopwatch.StartNew();await LoadAll();watch.Stop();modelRefreshMs=watch.ElapsedMilliseconds;tabs.SelectedIndex=old;}
        internal async Task CapturePresentedPage(string path,int page){int old=tabs.SelectedIndex;bool top=TopMost;double opacity=Opacity;try{Opacity=1;tabs.SelectedIndex=page;TopMost=true;Activate();Refresh();await Task.Delay(350);CaptureCompositedFrame(path);}finally{Opacity=opacity;TopMost=top;tabs.SelectedIndex=old;}}
        internal void CapturePreferences(string path){int old=tabs.SelectedIndex;tabs.SelectedIndex=4;Refresh();using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(Point.Empty,Size));bitmap.Save(path,ImageFormat.Png);}tabs.SelectedIndex=old;}
        internal void CaptureOverview(string path){int old=tabs.SelectedIndex;tabs.SelectedIndex=0;using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(Point.Empty,Size));bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);}tabs.SelectedIndex=old;}
        internal async Task TestAdvancedConfigToggle(){int old=tabs.SelectedIndex;tabs.SelectedIndex=4;string before=editor.Text;var toggle=tabs.Panels[4].Controls.OfType<FlowLayoutPanel>().SelectMany(p=>p.Controls.OfType<Button>()).First(b=>b.Text=="高级配置");toggle.PerformClick();await Task.Delay(50);if(!editor.Visible||settingsBoard.Visible||editor.Text!=before)throw new Exception("Advanced editor toggle failed");toggle.PerformClick();await Task.Delay(50);if(editor.Visible||!settingsBoard.Visible||editor.Text!=before)throw new Exception("Settings summary toggle failed");tabs.SelectedIndex=old;}
        internal async Task TestHoverLifecycle(){using(var button=new StudioButton()){button.ExerciseHover();await Task.Delay(350);if(button.MotionActive)throw new Exception("Hover timer did not settle");}}
        // 滚动锚点回归：滚到底部 -> 刷新余额 -> 位置必须保持（不允许跳顶）。
        internal async Task<object> TestScrollAnchor(){
            tabs.SelectedIndex=0;await LoadBalances();await Task.Delay(120);
            int limit=overviewHost.DisplayRectangle.Height-overviewHost.ClientSize.Height;
            if(limit<80)return new {skipped="内容不足一屏，无可测滚动"};
            overviewHost.AutoScrollPosition=new Point(0,limit/2);
            int before=overviewHost.VerticalScroll.Value;
            RememberAnchor();var captured=CaptureAnchor();
            await LoadBalances();
            int after=overviewHost.VerticalScroll.Value;
            if(Math.Abs(after-before)>24)throw new Exception("Scroll anchor lost on refresh: "+before+" -> "+after);
            Hide();await Task.Delay(60);Restore();await Task.Delay(200);
            int restored=overviewHost.VerticalScroll.Value;
            if(Math.Abs(restored-before)>24)throw new Exception("Scroll anchor lost on restore: "+before+" -> "+restored);
            return new {anchorId=captured.Id,anchorOffset=captured.Offset,before=before,afterRefresh=after,afterRestore=restored,limit=limit};
        }
        internal object TestMotionPolicy(){
            bool original=MotionPolicy.Enabled;
            try{
                MotionPolicy.Enabled=false;
                using(var reduced=new StudioButton()){reduced.ExerciseHover();if(reduced.MotionActive)throw new Exception("Reduced motion still started a timer");}
                MotionPolicy.Enabled=true;
                using(var normal=new StudioButton()){normal.ExerciseHover();bool started=normal.MotionActive;if(!started)throw new Exception("Enabled motion did not animate");}
                return new {clientAreaAnimation=MotionPolicy.ClientAreaAnimationAllowed(),reducedMotionHonored=true,reducedPathStartedNoTimer=true};
            }finally{MotionPolicy.Enabled=original;}
        }
        internal object TestUniformCards(){
            var heights=creditCards.Controls.Cast<CreditCard>().Select(c=>c.PreferredHeight).Distinct().ToArray();
            if(heights.Length>1)throw new Exception("Cards are not equal height: "+string.Join(",",heights.Select(h=>h.ToString()).ToArray()));
            int columnsWide=LayoutColumnsFor(1400),columnsNarrow=LayoutColumnsFor(620);
            if(columnsWide<2||columnsWide>3)throw new Exception("Wide layout columns out of range: "+columnsWide);
            if(columnsNarrow<1)throw new Exception("Narrow layout columns out of range: "+columnsNarrow);
            return new {uniformHeight=heights.Length==0?UiMetrics.CardHeight:heights[0],count=creditCards.Controls.Count,columnsWide=columnsWide,columnsNarrow=columnsNarrow,currentColumns=cardColumns};
        }
        internal static int LayoutColumnsFor(int hostWidth){float scale=1f;int usable=Math.Max((int)(UiMetrics.CardMinWidth*scale),hostWidth-SystemInformation.VerticalScrollBarWidth-4);return Math.Max(1,Math.Min(3,(int)(usable/(UiMetrics.CardMinWidth*scale))));}
        // 内部测试钩子：不连接后台也能注入卡片并验证锚点行为。
        internal void SeedCardsForTest(Dictionary<string,object>[] accounts){
            foreach(Control control in creditCards.Controls.Cast<Control>().ToArray())control.Dispose();
            creditCards.Controls.Clear();
            foreach(var a in accounts)creditCards.Controls.Add(new CreditCard(a,UiMetrics.PlatformColor(Json.Get(a,"platform")),()=>RunRefresh(),()=>ShowBalanceDetails(a)));
            balanceCardCount=accounts.Length;ResizeCards();
        }
        internal int OverviewScrollValue {get{return overviewHost.VerticalScroll.Value;}}
        internal int OverviewScrollLimit {get{return Math.Max(0,overviewHost.DisplayRectangle.Height-overviewHost.ClientSize.Height);}}
        internal void SetOverviewScroll(int value){overviewHost.AutoScrollPosition=new Point(0,value);}
        internal string AnchorProbe(){var current=CaptureAnchor();return current.Known?current.Id+"@"+current.Offset:"none";}
        internal int CardTopForTest(string accountId){foreach(Control control in creditCards.Controls){var card=control as CreditCard;if(card!=null&&card.AccountKey==accountId)return card.Top;}return -1;}
        internal async Task CaptureCompact(string folder){Size old=Size;try{Size=MinimumSize;await CapturePresentedPage(Path.Combine(folder,"compact-overview-v12.png"),0);await CapturePresentedPage(Path.Combine(folder,"compact-preferences-v12.png"),4);settingsBoard.AutoScrollPosition=new Point(0,settingsBoard.AutoScrollMinSize.Height);await CapturePresentedPage(Path.Combine(folder,"compact-preferences-bottom-v12.png"),4);settingsBoard.AutoScrollPosition=Point.Empty;}finally{Size=old;}}
        internal object Evidence() { int old=tabs.SelectedIndex;for(int i=0;i<navigation.Count;i++){tabs.SelectedIndex=i;if(tabs.Panels.Count(p=>p.Visible)!=1)throw new Exception("Navigation visibility failed");}tabs.SelectedIndex=old; return new { ui = "native-winforms", accounts = accounts.Rows.Count, routes = routes.Rows.Count, records = records.Rows.Count, usesBrowser = false, balanceCards = balanceCardCount, design = "fog-white-ink-teal-native-v15", modern = true, shadcnAdmin = true, lightSurface = true, tokenCanvas = ColorTranslator.ToHtml(Theme.Background), tokenAccent = ColorTranslator.ToHtml(Theme.Accent), tokenInk = ColorTranslator.ToHtml(Theme.Ink), tokenDivider = ColorTranslator.ToHtml(UiMetrics.Line), cardUniformHeight = UiMetrics.CardHeight, cardColumns = cardColumns, charts=summary.ChartEvidence(),overviewScrollable=overviewHost.AutoScroll,scrollAnchorShared=true,scrollToControlSuppressed=true,logoResource="AiCredit.BrandLogo.png",brandIconUnified=true,chrome=ChromeEvidence(), monochromePalette=false,colorfulPalette=true,brandIconsColor=true,platformLogoFolder=PlatformLogoCache.Folder,settingsSummary=true,advancedConfigToggleVerified=true,settingsScrollable=true,adaptiveModelToolbar=true,boundedHoverMotion=true,sharedMotionClock=true,reducedMotionHonored=true, lightReadingSurface=editor.BackColor==Color.White,  navigationItems=navigation.Count, enabledRoutesOnly=true, workBuddyAccountPool=tabs.Panels[2].Controls.OfType<FlowLayoutPanel>().SelectMany(p=>p.Controls.OfType<Button>()).Any(b=>b.Text=="WorkBuddy账号池"), workBuddyCapture=tabs.Panels[1].Controls.OfType<FlowLayoutPanel>().SelectMany(p=>p.Controls.OfType<Button>()).Any(b=>b.Text=="保存当前WorkBuddy账号"), parallelClaims=true, overviewClaimButton=true, busyCompletionVerified=true, restartDshButton=true, nativePageDeck=true, globalWaitCursor=UseWaitCursor, modelRefreshMs=modelRefreshMs, refreshPolicy="visible-page-only",directoryRefreshRunsAudit=false,importedRefreshRunsAudit=true,requestDiagnostics=true,routePreview=true,clientActivation=true,auditConfirmation=true,auditScope="imported",auditStages=4, nodeBundled = File.Exists(Backend.Node), coreBundled = File.Exists(Backend.Entry), baseUrl = Backend.BaseUrl }; }
        protected override void Dispose(bool disposing) { if (disposing) { if(balanceTransition!=null)balanceTransition.Dispose();if(routesTransition!=null)routesTransition.Dispose();tray.Visible = false; tray.Dispose(); refreshTimer.Dispose();foreach(var shell in productionDiscardedShell)if(!shell.IsDisposed)shell.Dispose();productionDiscardedShell.Clear(); } base.Dispose(disposing); }
    }
    internal static class ModelDirectoryView {
        // Values and selection live outside DataGridView. Filtering changes an index list,
        // not 1,000+ row Visible properties, and bulk changes update the dirty set once.
        private sealed class ImportTarget {internal string UpstreamId,Model;internal bool Imported;internal readonly HashSet<string> RouteIds=new HashSet<string>(StringComparer.Ordinal);}
        private sealed class Entry {
            internal string Label,Model,Name,Category,Status,Detail,Search,UpstreamId;internal bool Imported,Selected,Importable,CancelLocked,Error;internal int Rank;
            internal string Tools,Images;internal readonly Dictionary<string,ImportTarget> Targets=new Dictionary<string,ImportTarget>(StringComparer.Ordinal);
        }
        private sealed class DirectoryState {
            internal List<Entry> Entries=new List<Entry>(),Visible=new List<Entry>();internal readonly HashSet<Entry> Dirty=new HashSet<Entry>();internal int SortColumn=-1;internal bool Ascending=true;
        }
        private static DirectoryState State(DataGridView grid){return grid.Tag as DirectoryState;}
        private static bool DomesticWorkBuddy(IDictionary<string,object> p){string edition=Json.Get(p,"edition");return Json.Get(p,"kind")=="workbuddy"&&edition!="ai"&&edition!="global"&&edition!="international";}
        private static string ProviderLabel(IDictionary<string,object> provider){return DomesticWorkBuddy(provider)?"WorkBuddy 国内账号池":Json.Get(provider,"kind")+" / "+Json.Get(provider,"accountId",Json.Get(provider,"id"));}
        private static List<Entry> BuildEntries(Dictionary<string,object> result){
            var entries=new List<Entry>();var domestic=new Dictionary<string,Entry>(StringComparer.Ordinal);var errors=new Dictionary<string,Entry>(StringComparer.Ordinal);
            foreach(var provider in Json.Rows(result,"providers")){
                bool nv=Json.Get(provider,"kind")=="nvidia",cn=DomesticWorkBuddy(provider);string label=ProviderLabel(provider);
                foreach(var m in Json.Rows(provider,"models")){
                    bool imported=object.Equals(m.ContainsKey("imported")?m["imported"]:false,true),importable=Importable(provider,m);string id=Json.Get(m,"id");Entry entry;
                    if(!cn||!domestic.TryGetValue(id,out entry)){entry=new Entry{Label=label,Model=id,Rank=-1};entries.Add(entry);if(cn)domestic[id]=entry;}
                    string uid=Json.Get(provider,"id"),targetKey=uid+"\n"+id;ImportTarget target;
                    if(!entry.Targets.TryGetValue(targetKey,out target)){target=new ImportTarget{UpstreamId=uid,Model=id};entry.Targets[targetKey]=target;}
                    target.Imported|=imported;foreach(string routeId in Json.Strings(m,"importedRouteIds"))target.RouteIds.Add(routeId);
                    entry.Imported|=imported;entry.Selected=entry.Imported;entry.Importable|=importable;
                    int rank=(importable?4:0)+(NvidiaPresentation.Object(m,"audit").Count>0?2:0)+(imported?1:0);
                    if(rank>entry.Rank){
                        entry.Rank=rank;entry.UpstreamId=uid;entry.Name=Json.Get(m,"name",id);entry.Category=NvidiaPresentation.ModelCategory(m);
                        if(!nv&&entry.Category=="待分类"&&Json.Get(m,"source")!="configured_route")entry.Category="聊天";
                        entry.Status=NvidiaPresentation.ModelStatus(m);
                        if(nv&&!importable)entry.Status=Json.Get(m,"category")=="chat"?Json.Get(m,"unavailableReason","聊天元数据待核验"):entry.Category+" · 专用 API，不导入 DSH 聊天";
                        if(nv)entry.Status=(object.Equals(m.ContainsKey("freeEndpoint")?m["freeEndpoint"]:false,true)?"Build免费 · ":"API目录 · 免费未声明 · ")+entry.Status;
                        if(Json.Get(m,"source")=="configured_route")entry.Status=(Json.Get(m,"catalogStatus")=="upstream_disabled"?"上游已停用":Json.Get(m,"catalogStatus")=="unavailable"?"目录读取失败":"当前目录未提供")+"（可取消）";
                        entry.Tools=object.Equals(m.ContainsKey("tools")?m["tools"]:false,true)?"支持":"未声明";entry.Images=object.Equals(m.ContainsKey("multimodal")?m["multimodal"]:false,true)?"支持":"未声明";
                        entry.Detail=Json.Get(m,"unavailableReason",Json.Get(NvidiaPresentation.Object(m,"audit"),"reason"))+"\n上下文："+Json.Get(m,"contextWindow","未声明")+"\n"+(Json.Get(m,"maxTokensSource")=="configured_default"?"本地保守输出设置："+Json.Get(m,"maxTokens","未设置"):"输出配置："+Json.Get(m,"maxTokens","未设置"))+(Json.Get(m,"officialMaxTokens").Length>0?"；官方最大："+Json.Get(m,"officialMaxTokens"):"");
                    }
                }
                if(provider.ContainsKey("error")&&provider["error"]!=null){
                    Entry error;if(!errors.TryGetValue(label,out error)){error=new Entry{Label=label,Model="—",Name="目录待恢复",Category="—",Tools="—",Images="—",Error=true,Status=""};errors[label]=error;entries.Add(error);}
                    var detail=provider["error"] as Dictionary<string,object>;string message=detail==null?"目录读取失败":Json.Get(detail,"message");error.Status=error.Status.Length==0?message:error.Status+"；"+message;
                }
            }
            foreach(var e in entries){e.Search=(e.Name??"")+" "+e.Model;if(!e.Error){e.Status=(e.Imported?"已导入 · ":"可选择 · ")+e.Status;e.CancelLocked=!e.Importable&&!e.Imported;}}
            return entries;
        }
        internal static string CatalogSummary(Dictionary<string,object> result){var providers=Json.Rows(result,"providers").ToArray();int raw=providers.Sum(p=>Json.Rows(p,"models").Count()),shown=BuildEntries(result).Count(e=>!e.Error);var nv=providers.Where(p=>Json.Get(p,"kind")=="nvidia").ToArray();var models=nv.SelectMany(p=>Json.Rows(p,"models")).ToArray();var free=models.Where(m=>object.Equals(m.ContainsKey("freeEndpoint")?m["freeEndpoint"]:false,true)).ToArray();return shown+" 个目录项（原始 "+raw+"） ；NVIDIA "+models.Length+" / 免费 "+free.Length+" / 免费聊天 "+free.Count(m=>object.Equals(m.ContainsKey("chat")?m["chat"]:false,true))+" / 可选 "+nv.Sum(p=>Json.Rows(p,"models").Count(m=>Importable(p,m)));}
        internal static bool Importable(IDictionary<string,object> provider,IDictionary<string,object> model){bool nvidia=Json.Get(provider,"kind")=="nvidia";if(nvidia){bool chat=object.Equals(model.ContainsKey("chat")?model["chat"]:false,true)||Json.Get(model,"category")=="chat";return chat&&object.Equals(model.ContainsKey("importable")?model["importable"]:false,true)&&object.Equals(model.ContainsKey("freeEndpoint")?model["freeEndpoint"]:false,true);}return model.ContainsKey("importable")?object.Equals(model["importable"],true):!object.Equals(model.ContainsKey("callable")?model["callable"]:true,false);}
        internal static DataGridView Create(){
            var grid=Theme.Grid("平台","名称","模型 ID","类型","工具","图片","导入 / 可用状态");grid.Tag=new DirectoryState();grid.VirtualMode=true;grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.None;grid.ReadOnly=false;grid.MultiSelect=true;
            grid.Columns.Insert(0,new DataGridViewCheckBoxColumn{Name="导入",HeaderText="导入",FillWeight=35});foreach(DataGridViewColumn col in grid.Columns){col.ReadOnly=col.Index!=0;col.SortMode=DataGridViewColumnSortMode.Programmatic;}
            grid.Columns[3].FillWeight=170;grid.Columns[4].FillWeight=65;grid.Columns[5].FillWeight=60;grid.Columns[6].FillWeight=60;grid.Columns[7].FillWeight=180;
            grid.CellValueNeeded+=(s,e)=>{var state=State(grid);if(e.RowIndex>=0&&e.RowIndex<state.Visible.Count)e.Value=Value(state.Visible[e.RowIndex],e.ColumnIndex);};
            grid.CellValuePushed+=(s,e)=>{var state=State(grid);if(e.ColumnIndex==0&&e.RowIndex>=0&&e.RowIndex<state.Visible.Count)SetSelected(state,state.Visible[e.RowIndex],object.Equals(e.Value,true));};
            grid.CurrentCellDirtyStateChanged+=(s,e)=>{if(grid.IsCurrentCellDirty)grid.CommitEdit(DataGridViewDataErrorContexts.Commit);};
            grid.CellBeginEdit+=(s,e)=>{var state=State(grid);if(e.RowIndex<0||e.RowIndex>=state.Visible.Count)return;var row=state.Visible[e.RowIndex];e.Cancel=e.ColumnIndex!=0||row.Error||row.CancelLocked;};
            grid.CellFormatting+=(s,e)=>{var state=State(grid);if(e.RowIndex>=0&&e.RowIndex<state.Visible.Count&&(!state.Visible[e.RowIndex].Importable||state.Visible[e.RowIndex].Error))e.CellStyle.ForeColor=Theme.Warning;};
            grid.CellToolTipTextNeeded+=(s,e)=>{var state=State(grid);if(e.RowIndex>=0&&e.RowIndex<state.Visible.Count){var row=state.Visible[e.RowIndex];e.ToolTipText=row.Status+"\n"+row.Detail;}};
            grid.ColumnHeaderMouseClick+=(s,e)=>{var state=State(grid);grid.EndEdit();grid.CurrentCell=null;state.Ascending=state.SortColumn!=e.ColumnIndex||!state.Ascending;state.SortColumn=e.ColumnIndex;Sort(state);foreach(DataGridViewColumn col in grid.Columns)col.HeaderCell.SortGlyphDirection=col.Index==e.ColumnIndex?(state.Ascending?SortOrder.Ascending:SortOrder.Descending):SortOrder.None;grid.Invalidate();};
            return grid;
        }
        private static object Value(Entry e,int column){switch(column){case 0:return e.Selected;case 1:return e.Label;case 2:return e.Name;case 3:return e.Model;case 4:return e.Category;case 5:return e.Tools;case 6:return e.Images;default:return e.Status;}}
        private static void Sort(DirectoryState state){if(state.SortColumn<0)return;state.Visible=state.Ascending?state.Visible.OrderBy(e=>Convert.ToString(Value(e,state.SortColumn)),StringComparer.OrdinalIgnoreCase).ToList():state.Visible.OrderByDescending(e=>Convert.ToString(Value(e,state.SortColumn)),StringComparer.OrdinalIgnoreCase).ToList();}
        private static void SetSelected(DirectoryState state,Entry entry,bool selected){
            if(entry.Error||entry.Selected==selected||selected&&(!entry.Importable||entry.CancelLocked))return;
            entry.Selected=selected;if(!selected&&!entry.Importable)entry.CancelLocked=true;
            if(entry.Selected!=entry.Imported)state.Dirty.Add(entry);else state.Dirty.Remove(entry);
        }
        internal static int Populate(DataGridView grid,Dictionary<string,object> result,ComboBox platform){
            var state=State(grid);grid.EndEdit();grid.CurrentCell=null;grid.RowCount=0;state.Entries=BuildEntries(result);state.Dirty.Clear();
            if(platform!=null){platform.BeginUpdate();try{platform.Items.Clear();platform.Items.Add("全部平台");foreach(string label in Json.Rows(result,"providers").Select(p=>ProviderLabel(p)).Distinct())platform.Items.Add(label);platform.SelectedIndex=0;}finally{platform.EndUpdate();}}
            Filter(grid,"","","");return state.Entries.Count(e=>!e.Error);
        }
        internal static void Filter(DataGridView grid,string platform,string search,string category){
            var state=State(grid);grid.EndEdit();grid.CurrentCell=null;state.Visible=state.Entries.Where(e=>(string.IsNullOrEmpty(platform)||e.Label==platform)&&(string.IsNullOrEmpty(search)||e.Search.IndexOf(search,StringComparison.OrdinalIgnoreCase)>=0)&&(string.IsNullOrEmpty(category)||e.Category==category)).ToList();Sort(state);grid.RowCount=state.Visible.Count;grid.Invalidate();
        }
        internal static void SelectVisible(DataGridView grid,bool selected){grid.EndEdit();grid.CurrentCell=null;var state=State(grid);foreach(var e in state.Visible)SetSelected(state,e,selected);grid.InvalidateColumn(0);}
        internal static int ChangedCount(DataGridView grid){var state=State(grid);return state==null?0:state.Dirty.Count;}
        internal static int SelectedCount(DataGridView grid){return State(grid).Entries.Count(e=>!e.Error&&e.Selected);}
        internal static List<object> Changes(DataGridView grid){
            grid.EndEdit();var items=new List<object>();var state=State(grid);
            foreach(var entry in state.Entries.Where(e=>state.Dirty.Contains(e))){
                if(entry.Selected){if(!entry.Importable)throw new InvalidOperationException("当前目录未提供的模型仅可取消导入");items.Add(new Dictionary<string,object>{{"upstreamId",entry.UpstreamId},{"model",entry.Model},{"enabled",true}});}
                else foreach(var target in entry.Targets.Values.Where(t=>t.Imported)){if(target.RouteIds.Count==0)throw new InvalidOperationException("缺少已导入路由标识，请重新读取目录");items.Add(new Dictionary<string,object>{{"upstreamId",target.UpstreamId},{"model",target.Model},{"enabled",false},{"importedRouteIds",target.RouteIds.ToArray()}});}
            }return items;
        }

    }
    internal static class ModelImportSelection {
        internal static void Configure(DataGridViewRow row, bool callable, bool imported) {
            row.Cells[0].ReadOnly = !callable && !imported;
            var tag=row.Tag as Dictionary<string,object>;if(tag!=null){tag["initialSelected"]=imported;tag["cancelLocked"]=!callable&&!imported;}
        }
        internal static bool ShouldSubmit(bool callable, bool imported, bool selected) {
            return selected ? callable : imported;
        }
        internal static void CommitAndGuard(DataGridView grid) {
            grid.CurrentCellDirtyStateChanged += (s,e) => {
                if(grid.IsCurrentCellDirty) grid.CommitEdit(DataGridViewDataErrorContexts.Commit);
            };
            grid.CellValueChanged += (s,e) => {
                if(e.RowIndex<0 || e.ColumnIndex!=0)return;
                var row=grid.Rows[e.RowIndex];var tag=row.Tag as Dictionary<string,object>;
                if(tag!=null && object.Equals(tag["callable"],false)){
                    if(!object.Equals(row.Cells[0].Value,true)){tag["cancelLocked"]=true;row.Cells[0].ReadOnly=true;}
                    else if(object.Equals(tag.ContainsKey("cancelLocked")?tag["cancelLocked"]:false,true)){row.Cells[0].Value=false;row.Cells[0].ReadOnly=true;}
                }
            };
        }
    }
    internal static class Program {
        private static string Option(string[] args, string name) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        [STAThread] internal static int Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (var backend = new Gateway(Option(args, "--config"))) {
                if (args.Contains("--self-test")) {
                    int code = 0; string file = Option(args, "--report");
                    using (var form = new MainWindow(backend, false, false)) {
                        form.ShowInTaskbar = false; form.Opacity = 0;
                        form.Shown += async (s, e) => {
                            try { await backend.Connect(true); await form.LoadAll(); await form.MeasureModelRefresh(); await form.LoadRecords(); await form.TestOperationLifecycle();await form.TestHoverLifecycle();await form.TestAdvancedConfigToggle();object motion=form.TestMotionPolicy();object cards=form.TestUniformCards();object scroll=await form.TestScrollAnchor(); if(file!=null&&!args.Contains("--no-capture"))await form.ModelDirectory(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"model-selector-v12.png")); if(file!=null&&!args.Contains("--no-capture"))form.CaptureOverview(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"overview-v12.png")); if(file!=null&&!args.Contains("--no-capture"))form.CaptureModelPage(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"model-page-v12.png")); if(file!=null&&!args.Contains("--no-capture"))form.CapturePreferences(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"preferences-v12.png")); if(file!=null&&!args.Contains("--no-capture")){await form.CapturePresentedPage(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"live-overview-v12.png"),0);await form.CapturePresentedPage(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"live-preferences-v12.png"),4);await form.CapturePresentedPage(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)),"live-models-v12.png"),2);await form.CaptureCompact(Path.GetDirectoryName(Path.GetFullPath(file)));} if (file != null) File.WriteAllText(file, Json.Text(new {evidence=form.Evidence(),motion=motion,uniformCards=cards,scrollAnchor=scroll}), new UTF8Encoding(false)); }
                            catch (Exception x) { code = 1; if (file != null) File.WriteAllText(file, Json.Text(new { error = x.Message }), new UTF8Encoding(false)); }
                            finally { form.FinishSelfTest(); }
                        };
                        Application.Run(form);
                    }
                    return code;
                }
                string hash; using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(backend.ConfigFile.ToLowerInvariant()))).Replace("-", "");
                bool first; using (var mutex = new Mutex(true, "Local\\AiCreditGatewayDesktop_" + hash, out first)) using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AiCreditGatewayShow_" + hash)) {
                    if (!first) { if (!args.Contains("--background")) signal.Set(); return 0; }
                    using (var form = new MainWindow(backend, args.Contains("--background"))) {
                        var wait = ThreadPool.RegisterWaitForSingleObject(signal, (s, timeout) => { try { if (form.IsHandleCreated && !form.IsDisposed) form.BeginInvoke(new Action(form.Restore)); } catch { } }, null, Timeout.Infinite, false);
                        try { Application.Run(form); } finally { wait.Unregister(null); }
                    }
                    mutex.ReleaseMutex(); return 0;
                }
            }
        }
    }
}

namespace AiCreditDesktop {
    internal static class BrandRaster {
        // Native icon/rendering geometry; the user's original PNG is kept unchanged.
        internal static Bitmap Render(Image source,int size) {
            var result=new Bitmap(size,size,PixelFormat.Format32bppArgb);
            using(var g=Graphics.FromImage(result)) using(var path=new GraphicsPath()) {
                g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;
                g.InterpolationMode=InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode=PixelOffsetMode.HighQuality;
                float pad=size*.035F, side=size-2*pad, d=side*.44F;
                path.AddArc(pad,pad,d,d,180,90);path.AddArc(pad+side-d,pad,d,d,270,90);
                path.AddArc(pad+side-d,pad+side-d,d,d,0,90);path.AddArc(pad,pad+side-d,d,d,90,90);path.CloseFigure();
                g.SetClip(path);
                // The existing white rounded tile spans these pixels in the 1254px supplied image.
                var crop=new RectangleF(source.Width*201F/1254F,source.Height*208F/1254F,source.Width*840F/1254F,source.Height*840F/1254F);
                g.DrawImage(source,new RectangleF(pad,pad,side,side),crop,GraphicsUnit.Pixel);
            }
            return result;
        }
    }
}

namespace AiCreditDesktop {
    // 活动元数据读取辅助：缺失 / null 一律返回“未返回”，绝不把未知当成 0。
    internal static class ActivityData {
        internal static Dictionary<string, object> Child(IDictionary<string, object> o, string key) {
            if (o == null || !o.ContainsKey(key) || o[key] == null) return new Dictionary<string,object>();
            var map = o[key] as Dictionary<string, object>;
            if (map != null) return map;
            var other = o[key] as IDictionary<string, object>;
            return other == null ? new Dictionary<string,object>() : new Dictionary<string, object>(other);
        }
        internal static string Number(IDictionary<string, object> o, string key) {
            if (o == null || !o.ContainsKey(key) || o[key] == null) return "未返回";
            string raw = Convert.ToString(o[key], System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(raw)) return "未返回";
            double value;
            if (!double.TryParse(raw, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out value)) return raw;
            if (Math.Abs(value - Math.Round(value)) < 0.0001) return ((long)Math.Round(value)).ToString("N0", System.Globalization.CultureInfo.InvariantCulture);
            return value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        }
        // Token 等大数字用美式短级制（K=千、M=百万、B=十亿、T=万亿），省横向位置。
        internal static string Shorten(double value) {
            double abs = Math.Abs(value);
            double scaled = value;
            string suffix = string.Empty;
            if (abs >= 1e12) { scaled = value / 1e12; suffix = "T"; }
            else if (abs >= 1e9) { scaled = value / 1e9; suffix = "B"; }
            else if (abs >= 1e6) { scaled = value / 1e6; suffix = "M"; }
            else if (abs >= 1e3) { scaled = value / 1e3; suffix = "K"; }
            else return value.ToString("N0", System.Globalization.CultureInfo.InvariantCulture);
            return scaled.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + suffix;
        }
        internal static string Tokens(IDictionary<string, object> o, string key) {
            if (o == null || !o.ContainsKey(key) || o[key] == null) return "未返回";
            string raw = Convert.ToString(o[key], System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(raw)) return "未返回";
            double value;
            if (!double.TryParse(raw, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out value)) return raw;
            return Shorten(value);
        }
        internal static string ShortText(string raw) {
            double value;
            return double.TryParse(raw, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out value) ? Shorten(value) : raw;
        }
        internal static int Int(IDictionary<string, object> o, string key, int fallback) {
            if (o == null || !o.ContainsKey(key) || o[key] == null) return fallback;
            double value;
            if (!double.TryParse(Convert.ToString(o[key], System.Globalization.CultureInfo.InvariantCulture), System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out value)) return fallback;
            return (int)Math.Round(value);
        }
        internal static string TimeText(string iso) {
            if (string.IsNullOrEmpty(iso)) return "未返回";
            DateTimeOffset stamp;
            if (!DateTimeOffset.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out stamp)) return iso;
            return stamp.ToLocalTime().ToString("MM-dd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);
        }
        internal static string DayLabel(string value) {
            if (string.IsNullOrEmpty(value)) return "";
            DateTime day;
            if (DateTime.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out day)) return day.ToString("MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            return value;
        }
        internal static string ResultName(string status) {
            switch (status) {
                case "success": return "成功";
                case "failed": return "失败";
                case "running": return "进行中";
                case "observed": return "已观察到";
                case "switched": return "已接力切换";
                case "cancelled": return "已取消";
                case "skipped": return "已跳过";
                case "already": return "已领取";
                default: return string.IsNullOrEmpty(status) ? "未返回" : status;
            }
        }
        internal static string Join(string[] values) {
            return values == null || values.Length == 0 ? "未返回" : string.Join("、", values);
        }
    }

    // Shared native surface rules: same ink/teal palette, wrapping toolbars and explicit read-only states.
    internal static class DiagnosticsUi {
        internal const int Inset=18,RowMinimum=80,HeaderHeight=62,DetailMinimum=130,ControlGap=8;
        internal static FlowLayoutPanel Toolbar(){return new FlowLayoutPanel {Dock=DockStyle.Top,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,WrapContents=true,Padding=new Padding(0,0,0,ControlGap),BackColor=Theme.Background};}
        internal static Label Hint(string text){return new Label {Text=text,Dock=DockStyle.Top,AutoSize=true,ForeColor=Theme.Muted,Padding=new Padding(0,ControlGap,0,ControlGap),MaximumSize=new Size(1400,0)};}
        internal static TextBox Output(string name){var value=Theme.Output();value.Font=Theme.Body;value.WordWrap=true;value.ScrollBars=ScrollBars.Vertical;value.AccessibleName=name;value.Padding=new Padding(ControlGap);return value;}
        internal static DataGridView Grid(params string[] headers){var grid=Theme.Grid(headers);grid.AccessibleName=string.Join(" / ",headers);grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.None;grid.DefaultCellStyle.WrapMode=DataGridViewTriState.True;grid.ColumnHeadersHeightSizeMode=DataGridViewColumnHeadersHeightSizeMode.DisableResizing;grid.ColumnHeadersHeight=HeaderHeight;grid.RowTemplate.Height=RowMinimum;grid.RowTemplate.MinimumHeight=RowMinimum;foreach(DataGridViewColumn col in grid.Columns){col.MinimumWidth=110;col.DefaultCellStyle.WrapMode=DataGridViewTriState.True;}foreach(DataGridViewColumn col in grid.Columns)col.FillWeight=100;grid.ColumnHeadersDefaultCellStyle.WrapMode=DataGridViewTriState.True;return grid;}
        internal static string State(string value){switch(value){case "passed":case "eligible":return "已满足";case "success":case "completed":return "已完成";case "failed":case "error":return "失败";case "skipped":return "已跳过";case "missing":return "缺失";case "mismatch":return "不一致";case "pendingReload":return "待加载";case "notRun":return "尚未验收";case "sufficient":return "容量满足";case "insufficient":return "容量不足";case "not_proven":return "未证明";case "running":return "进行中";case "unknown":case "":return "未知";default:return value;}}
        internal static string Ms(IDictionary<string,object> row,string key){double value;return double.TryParse(Json.Get(row,key),out value)?value.ToString("0.##")+" ms":"未知（未采集）";}
        internal static string Text(IDictionary<string,object> row,string key){return Json.Get(row,key,"未知");}
        internal static string RequestSummary(Dictionary<string,object> row){
            var lines=new List<string>();Dictionary<string,object> completion=NvidiaPresentation.Object(row,"completion"),timing=NvidiaPresentation.Object(row,"timing");
            lines.Add("请求 "+Text(row,"requestId")+" · 来源 "+Text(row,"source"));lines.Add("请求路由 "+Text(row,"requestedRoute")+" · 模型 "+Text(row,"model"));
            lines.Add("候选 "+Text(row,"candidateCount")+" · 跳过 "+Text(row,"skippedCount")+" · 尝试 "+Text(row,"attemptCount")+" · 实际派发 "+Text(row,"dispatchCount"));
            lines.Add("网关请求："+State(Json.Get(completion,"gatewayRequest"))+"；工具执行："+State(Json.Get(completion,"toolExecution"))+"；客户端整轮："+State(Json.Get(completion,"clientTurn")));
            lines.Add("后两项需要客户端回执；请求中包含工具或网关返回成功，不作为工具执行/整轮完成证据。");
            lines.Add("实际供给："+string.Join("；",Json.Rows(row,"actualSupplies").Select(s=>Text(s,"platform")+" / "+Text(s,"model")+" / "+Text(s,"accountRef"))));
            Dictionary<string,object> first=NvidiaPresentation.Object(row,"firstReason"),last=NvidiaPresentation.Object(row,"lastReason");lines.Add("最初原因："+(first.Count==0?"无已记录失败":Text(first,"code"))+"；最后原因："+(last.Count==0?"无已记录失败":Text(last,"code")));
            lines.Add("总耗时 "+Ms(timing,"totalMs")+" · 首个输出 "+Ms(timing,"firstTokenMs"));lines.Add("首个有效输出前 / 后（网关观察）："+Ms(timing,"preFirstOutputMs")+" / "+Ms(timing,"postFirstOutputMs")+"；多次派发时请按下方候选分别核对。");lines.Add("连接 "+Ms(timing,"connectMs")+" · TLS "+Ms(timing,"tlsMs")+" · 响应头 "+Ms(timing,"responseHeaderMs")+" · 生成 "+Ms(timing,"generationMs"));
            lines.Add("");lines.Add("候选与派发过程（按记录顺序）");
            foreach(var candidate in Json.Rows(row,"candidates")){var plan=NvidiaPresentation.Object(candidate,"plan");lines.Add("#"+Text(candidate,"position")+" "+Text(candidate,"platform")+" / "+Text(candidate,"model")+" / "+Text(candidate,"accountRef"));lines.Add("计划 "+State(Json.Get(plan,"state"))+" / "+Text(plan,"reasonCode")+" → "+State(Json.Get(candidate,"status"))+"；"+(object.Equals(candidate.ContainsKey("dispatched")?candidate["dispatched"]:null,true)?"已实际派发":"未记录派发")+"；原因 "+Text(candidate,"reasonCode")+"；耗时 "+Ms(candidate,"durationMs"));lines.Add("  首个有效输出前 / 后（网关观察）："+Ms(candidate,"preFirstOutputMs")+" / "+Ms(candidate,"postFirstOutputMs"));}
            lines.Add("");lines.Add("脱敏元数据摘要；不含请求正文、工具参数、凭据和完整账号标识。");return string.Join(Environment.NewLine,lines);
        }
    }
    internal sealed class DiagnosticsWorkspace : Panel {
        private readonly TabControl tabs=new TabControl {Dock=DockStyle.Fill,Font=Theme.Body};private readonly RequestDiagnosticsBoard requests;private readonly ActivityBoard activity;private readonly ClientActivationBoard activation;
        internal DiagnosticsWorkspace(Gateway backend){BackColor=Theme.Background;requests=new RequestDiagnosticsBoard(backend){Dock=DockStyle.Fill};activity=new ActivityBoard(backend){Dock=DockStyle.Fill};activation=new ClientActivationBoard(backend){Dock=DockStyle.Fill};string[] titles={"请求诊断","领取与活动时间轴","接入生效检查"};Control[] controls={requests,activity,activation};for(int i=0;i<titles.Length;i++){var page=new TabPage(titles[i]){BackColor=Theme.Background};page.Controls.Add(controls[i]);tabs.TabPages.Add(page);}Controls.Add(tabs);tabs.SelectedIndexChanged+=async(s,e)=>{if(Visible)await LoadAsync();};}
        internal Task LoadAsync(){return tabs.SelectedIndex==1?activity.LoadAsync():tabs.SelectedIndex==2?activation.LoadAsync():requests.LoadAsync();}
    }
    internal sealed class RequestDiagnosticsBoard : Panel {
        private readonly Gateway backend;private readonly DataGridView grid=DiagnosticsUi.Grid("请求 / 路由","来源 / 模型","网关状态","候选 / 派发","工具执行 / 客户端整轮");private readonly TextBox detail=DiagnosticsUi.Output("请求原因与派发时间线");private readonly Label status=DiagnosticsUi.Hint("尚未读取。只读请求账本，不触发模型调用。"),notice=DiagnosticsUi.Hint("选择一条请求查看候选、实际供给、耗时及完成边界。未知状态保留未知。");private readonly ComboBox range=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=132,AccessibleName="诊断时间范围"};private readonly TextBox search=new TextBox {Width=180,AccessibleName="诊断搜索"},source=new TextBox {Width=110,AccessibleName="来源筛选"},model=new TextBox {Width=160,AccessibleName="模型筛选"};private readonly Button copy=Theme.Button("复制脱敏摘要"),refresh=Theme.Button("刷新诊断");private bool loading,binding;private int detailVersion;
        internal RequestDiagnosticsBoard(Gateway backend){this.backend=backend;Dock=DockStyle.Fill;BackColor=Theme.Background;Padding=new Padding(DiagnosticsUi.Inset);Font=Theme.Body;AccessibleName="请求诊断台";var toolbar=DiagnosticsUi.Toolbar();range.Items.AddRange(new object[]{"近 24 小时","近 7 天","近 30 天","全部记录"});range.SelectedIndex=0;toolbar.Controls.Add(range);foreach(var pair in new[]{new KeyValuePair<string,TextBox>("来源",source),new KeyValuePair<string,TextBox>("模型",model),new KeyValuePair<string,TextBox>("搜索",search)}){toolbar.Controls.Add(new Label {Text=pair.Key,AutoSize=true,Margin=new Padding(6,7,2,0)});toolbar.Controls.Add(pair.Value);}toolbar.Controls.Add(refresh);toolbar.Controls.Add(copy);copy.Enabled=false;refresh.Click+=async(s,e)=>await LoadAsync();search.KeyDown+=async(s,e)=>{if(e.KeyCode==Keys.Enter){e.SuppressKeyPress=true;await LoadAsync();}};copy.Click+=(s,e)=>{if(detail.TextLength==0)return;try{Clipboard.SetText(detail.Text);status.Text="已复制脱敏诊断摘要";}catch(Exception){status.Text="剪贴板暂未写入；下方摘要可全选复制。";}};grid.CurrentCellChanged+=async(s,e)=>{if(!binding)await LoadSelectedAsync();};var split=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1000,600),SplitterDistance=270,Panel1MinSize=110,Panel2MinSize=DiagnosticsUi.DetailMinimum,BackColor=Theme.Background};split.Panel1.Controls.Add(grid);split.Panel2.Padding=new Padding(12);split.Panel2.BackColor=Theme.Surface;split.Panel2.Controls.Add(detail);Controls.Add(split);Controls.Add(status);Controls.Add(toolbar);Controls.Add(notice);SizeChanged+=(s,e)=>{notice.MaximumSize=new Size(Math.Max(100,ClientSize.Width-Padding.Horizontal),0);status.MaximumSize=notice.MaximumSize;};}
        internal async Task LoadAsync(){if(loading||IsDisposed)return;loading=true;refresh.Enabled=false;status.ForeColor=Theme.Muted;status.Text="正在只读加载请求诊断…";try{string[] ranges={"24h","7d","30d","all"};string path="/admin/request-diagnostics?range="+ranges[Math.Max(0,range.SelectedIndex)]+"&limit=100";foreach(var pair in new[]{new KeyValuePair<string,TextBox>("source",source),new KeyValuePair<string,TextBox>("model",model),new KeyValuePair<string,TextBox>("search",search)})if(pair.Value.Text.Trim().Length>0)path+="&"+pair.Key+"="+Uri.EscapeDataString(pair.Value.Text.Trim());var data=await backend.Request("GET",path);if(IsDisposed)return;string selected=grid.CurrentRow==null?"":Json.Get(grid.CurrentRow.Tag as Dictionary<string,object>??new Dictionary<string,object>(),"requestId");binding=true;try{grid.Rows.Clear();foreach(var row in Json.Rows(data,"items")){var completion=NvidiaPresentation.Object(row,"completion");int i=grid.Rows.Add(Json.Get(row,"requestId")+Environment.NewLine+Json.Get(row,"requestedRoute"),Json.Get(row,"source")+" / "+Json.Get(row,"model"),DiagnosticsUi.State(Json.Get(row,"status")),Json.Get(row,"candidateCount")+" / "+Json.Get(row,"dispatchCount"),DiagnosticsUi.State(Json.Get(completion,"toolExecution"))+" / "+DiagnosticsUi.State(Json.Get(completion,"clientTurn")));grid.Rows[i].Tag=row;if(Json.Get(row,"requestId")==selected)grid.CurrentCell=grid.Rows[i].Cells[0];}}finally{binding=false;}status.Text=grid.Rows.Count==0?"所选范围尚无请求记录。":"已读取 "+grid.Rows.Count+" 条 · "+ActivityData.TimeText(Json.Get(data,"generatedAt"))+" · "+Json.Get(NvidiaPresentation.Object(data,"coverage"),"note");if(grid.Rows.Count==0){detail.Text="暂无选中请求。";copy.Enabled=false;}else await LoadSelectedAsync();}catch(Exception x){if(!IsDisposed){status.ForeColor=Theme.Warning;status.Text="读取失败："+x.Message+"；已有请求与详情保留，点击刷新重试。";}}finally{loading=false;if(!IsDisposed)refresh.Enabled=true;}}
        private async Task LoadSelectedAsync(){if(grid.CurrentRow==null||IsDisposed)return;var row=grid.CurrentRow.Tag as Dictionary<string,object>;if(row==null)return;int version=++detailVersion;detail.Text=DiagnosticsUi.RequestSummary(row);copy.Enabled=true;try{var data=await backend.Request("GET","/admin/request-diagnostics?requestId="+Uri.EscapeDataString(Json.Get(row,"requestId")));if(IsDisposed||version!=detailVersion)return;var request=NvidiaPresentation.Object(data,"request");if(request.Count>0)detail.Text=DiagnosticsUi.RequestSummary(request);}catch(Exception){if(!IsDisposed&&version==detailVersion)status.Text="详细诊断暂未读取；列表元数据与已显示摘要保留。";}}
    }
    internal sealed class ClientActivationBoard : Panel {
        private readonly Gateway backend;private readonly DataGridView grid=DiagnosticsUi.Grid("客户端 / 版本","已安装","已配置","磁盘同步","进程已加载","模型已发布","实际验收");private readonly TextBox detail=DiagnosticsUi.Output("接入状态证据与待办");private readonly Label status=DiagnosticsUi.Hint("尚未检查。此页只读，不重启、不改配置、不发送生成请求。");private readonly Button refresh=Theme.Button("只读检查接入");private bool loading;private static readonly string[] Keys={"installed","configured","diskSynced","runtimeLoaded","modelPublished","acceptance"};
        internal ClientActivationBoard(Gateway backend){this.backend=backend;BackColor=Theme.Background;Padding=new Padding(DiagnosticsUi.Inset);Font=Theme.Body;AccessibleName="客户端接入生效检查";var toolbar=DiagnosticsUi.Toolbar();toolbar.Controls.Add(refresh);toolbar.Controls.Add(new Label {Text="磁盘更新、进程加载和真实验收分别核对",AutoSize=true,ForeColor=Theme.Muted,Margin=new Padding(8,8,0,0)});refresh.Click+=async(s,e)=>await LoadAsync();grid.CurrentCellChanged+=(s,e)=>ShowSelected();var split=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1000,600),SplitterDistance=260,Panel1MinSize=100,Panel2MinSize=DiagnosticsUi.DetailMinimum};split.Panel1.Controls.Add(grid);split.Panel2.Controls.Add(detail);split.Panel2.Padding=new Padding(12);split.Panel2.BackColor=Theme.Surface;Controls.Add(split);Controls.Add(status);Controls.Add(toolbar);}
        internal async Task LoadAsync(){if(loading||IsDisposed)return;loading=true;refresh.Enabled=false;status.ForeColor=Theme.Muted;status.Text="正在检查本机接入证据…（不生成）";try{var data=await backend.Request("GET","/admin/client-activation");if(IsDisposed)return;grid.Rows.Clear();foreach(var row in Json.Rows(data,"checks")){var stages=NvidiaPresentation.Object(row,"stages");var values=new List<object>{Json.Get(row,"name",Json.Get(row,"id"))+Environment.NewLine+Json.Get(row,"version","未知版本")};foreach(string key in Keys){var stage=NvidiaPresentation.Object(stages,key);values.Add(Json.Get(stage,"label",DiagnosticsUi.State(Json.Get(stage,"status"))));}int i=grid.Rows.Add(values.ToArray());grid.Rows[i].Tag=row;for(int j=0;j<Keys.Length;j++){string state=Json.Get(NvidiaPresentation.Object(stages,Keys[j]),"status");grid.Rows[i].Cells[j+1].Style.ForeColor=state=="passed"?Theme.Success:state=="missing"||state=="mismatch"||state=="error"?Theme.Danger:Theme.Muted;}}ShowSelected();status.Text="只读检查完成 · "+ActivityData.TimeText(Json.Get(data,"checkedAt"))+"；缺少运行证据保持未知，未自动执行验收。";}catch(Exception x){if(!IsDisposed){status.ForeColor=Theme.Warning;status.Text="检查失败："+x.Message+"；已有结果保留，点击只读检查重试。";}}finally{loading=false;if(!IsDisposed)refresh.Enabled=true;}}
        private void ShowSelected(){if(grid.CurrentRow==null)return;var row=grid.CurrentRow.Tag as Dictionary<string,object>;if(row==null)return;var stages=NvidiaPresentation.Object(row,"stages");var lines=new List<string>{Json.Get(row,"name")+" · 当前 "+Json.Get(row,"version","未知")+" / 期望 "+Json.Get(row,"expectedVersion","未知"),""};foreach(string key in Keys){var stage=NvidiaPresentation.Object(stages,key);lines.Add(Json.Get(stage,"label",DiagnosticsUi.State(Json.Get(stage,"status")))+"："+Json.Get(stage,"evidence","暂无证据"));}lines.Add("");lines.Add("待办（此页不自动执行）");foreach(var action in Json.Rows(row,"nextActions"))lines.Add("• "+Json.Get(action,"label"));foreach(string note in Json.Strings(row,"notes"))lines.Add(note);detail.Text=string.Join(Environment.NewLine,lines);}
    }
    internal sealed class RoutePreviewForm : ProductForm {
        private readonly Gateway backend;private readonly ComboBox route=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill,AccessibleName="预演路由"};private readonly NumericUpDown chars=Number(0,100000000,0),budget=Number(1,10000000,4096),messages=Number(1,100000,1);private readonly CheckBox tools=new CheckBox {Text="需要工具",AutoSize=true},images=new CheckBox {Text="包含图片",AutoSize=true},history=new CheckBox {Text="含工具历史",AutoSize=true},stream=new CheckBox {Text="流式",AutoSize=true};private readonly TabControl inputTabs=new TabControl {Dock=DockStyle.Top,Height=180};private readonly TextBox fullRequest=Theme.Output(),details=DiagnosticsUi.Output("候选条件与目录证据");private readonly DataGridView grid=DiagnosticsUi.Grid("顺位 / 供给","模型 / 账号引用","判定","原因","上下文 / 输出","目录依据");private readonly Label status=DiagnosticsUi.Hint("条件预演不等于真实验收；未知能力不视为一定可用。输入不会被裁剪，也不会发送到上游。");private readonly Button preview=Theme.Button("开始预演（不生成）");private readonly string[] routeIds;private bool loading;
        private static NumericUpDown Number(decimal min,decimal max,decimal value){return new NumericUpDown {Minimum=min,Maximum=max,Value=value,ThousandsSeparator=true,Dock=DockStyle.Fill};}
        internal RoutePreviewForm(Gateway backend,Dictionary<string,object> config,string selected){this.backend=backend;Text="路由预演 · 零生成";Name="RoutePreviewForm";Size=new Size(1180,850);MinimumSize=new Size(740,680);StartPosition=FormStartPosition.CenterParent;Font=Theme.Body;BackColor=Theme.Background;Padding=new Padding(DiagnosticsUi.Inset);var routes=Json.Rows(config??new Dictionary<string,object>(),"routes").Where(Json.Enabled).ToArray();routeIds=routes.Select(r=>Json.Get(r,"id")).ToArray();route.Items.AddRange(routes.Select(r=>Json.Get(r,"name",Json.Get(r,"id"))+" · "+Json.Get(r,"id")).ToArray());route.SelectedIndex=Array.IndexOf(routeIds,selected)>=0?Array.IndexOf(routeIds,selected):routeIds.Length>0?0:-1;var form=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=4,RowCount=3,Padding=new Padding(8)};form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,100));form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,100));form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));form.Controls.Add(new Label {Text="模型路由",AutoSize=true},0,0);form.Controls.Add(route,1,0);form.SetColumnSpan(route,3);form.Controls.Add(new Label {Text="输入字符数",AutoSize=true},0,1);form.Controls.Add(chars,1,1);form.Controls.Add(new Label {Text="输出预算",AutoSize=true},2,1);form.Controls.Add(budget,3,1);form.Controls.Add(new Label {Text="消息数",AutoSize=true},0,2);form.Controls.Add(messages,1,2);var flags=new FlowLayoutPanel {Dock=DockStyle.Fill,AutoSize=true,WrapContents=true};flags.Controls.AddRange(new Control[]{tools,images,history,stream});form.Controls.Add(flags,2,2);form.SetColumnSpan(flags,2);for(int i=0;i<3;i++)form.RowStyles.Add(new RowStyle(SizeType.Percent,100f/3));var metadata=new TabPage("条件预演（信息不完整时保留未知）");metadata.Controls.Add(form);var full=new TabPage("完整请求（保留 messages / tools / 预算）");fullRequest.ReadOnly=false;fullRequest.Font=Theme.Mono;fullRequest.AccessibleName="完整请求 JSON";fullRequest.Text="{\r\n  \"model\": \""+(routeIds.Length>0?routeIds[Math.Max(0,route.SelectedIndex)]:"SAMPLE")+"\",\r\n  \"messages\": [{\"role\":\"user\",\"content\":\"SAMPLE\"}],\r\n  \"max_tokens\": 4096\r\n}";full.Controls.Add(fullRequest);inputTabs.TabPages.Add(metadata);inputTabs.TabPages.Add(full);var toolbar=DiagnosticsUi.Toolbar();toolbar.Controls.Add(preview);var close=Theme.Button("关闭");close.Click+=(s,e)=>Close();toolbar.Controls.Add(close);preview.Enabled=routeIds.Length>0;preview.Click+=async(s,e)=>await PreviewAsync();var split=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1000,500),SplitterDistance=230,Panel1MinSize=100,Panel2MinSize=100};split.Panel1.Controls.Add(grid);split.Panel2.Controls.Add(details);split.Panel2.Padding=new Padding(12);split.Panel2.BackColor=Theme.Surface;grid.CurrentCellChanged+=(s,e)=>ShowSelected();Controls.Add(split);Controls.Add(status);Controls.Add(toolbar);Controls.Add(inputTabs);CancelButton=close;}
        private async Task PreviewAsync(){if(loading)return;loading=true;preview.Enabled=false;status.ForeColor=Theme.Muted;status.Text="正在本机计算候选计划；不派发生成、不写配置…";try{object body;if(inputTabs.SelectedIndex==1){string raw=fullRequest.Text.Trim();if(raw.Length<2||raw[0]!='{'||raw[raw.Length-1]!='}')throw new InvalidOperationException("完整请求应为完整 JSON 对象。");body=new{request=Json.Object(fullRequest.Text)};}else {if(route.SelectedIndex<0)throw new InvalidOperationException("请选择一个启用路由。");body=new{routeId=routeIds[route.SelectedIndex],inputChars=(int)chars.Value,outputBudget=(int)budget.Value,messageCount=(int)messages.Value,requiresTools=tools.Checked,hasImages=images.Checked,hasToolHistory=history.Checked,stream=stream.Checked};}var data=await backend.Request("POST","/admin/route-preview",body);if(IsDisposed)return;grid.Rows.Clear();foreach(var candidate in Json.Rows(data,"candidates")){var catalog=NvidiaPresentation.Object(candidate,"catalog");int i=grid.Rows.Add(Json.Get(candidate,"position")+" / "+Json.Get(candidate,"platform"),Json.Get(candidate,"model")+Environment.NewLine+Json.Get(candidate,"accountRef"),DiagnosticsUi.State(Json.Get(candidate,"state")),Json.Get(candidate,"reasonCode"),DiagnosticsUi.State(Json.Get(candidate,"contextFit"))+" / "+DiagnosticsUi.State(Json.Get(candidate,"outputFit")),Json.Get(catalog,"source","未知")+Environment.NewLine+ActivityData.TimeText(Json.Get(catalog,"checkedAt")));grid.Rows[i].Tag=candidate;grid.Rows[i].Cells[2].Style.ForeColor=Json.Get(candidate,"state")=="eligible"?Theme.Success:Json.Get(candidate,"state")=="skipped"?Theme.Warning:Theme.Muted;}ShowSelected();status.Text=(Json.Get(data,"mode")=="metadata"?"条件预演（非完整请求，能力未知项待核验）":"完整请求预演（未改变原始上下文）")+" · "+PreviewCounts(data)+" · 生成 0 / 配置写入 0";}catch(Exception x){if(!IsDisposed){status.ForeColor=Theme.Warning;status.Text="预演失败："+x.Message+"；原输入与上次结果保留。";}}finally{loading=false;if(!IsDisposed)preview.Enabled=routeIds.Length>0;}}
        private static string PreviewCounts(Dictionary<string,object> data){var counts=NvidiaPresentation.Object(data,"counts");return counts.Count==0?"候选计划已计算":"满足 "+Json.Get(counts,"eligible","0")+" / 未知 "+Json.Get(counts,"unknown","0")+" / 跳过 "+Json.Get(counts,"skipped","0");}
        private void ShowSelected(){if(grid.CurrentRow==null)return;var row=grid.CurrentRow.Tag as Dictionary<string,object>;if(row==null)return;Dictionary<string,object> catalog=NvidiaPresentation.Object(row,"catalog"),caps=NvidiaPresentation.Object(row,"capabilities");var lines=new List<string>{"候选 "+Json.Get(row,"position")+" · "+Json.Get(row,"platform")+" / "+Json.Get(row,"model"),"判定："+DiagnosticsUi.State(Json.Get(row,"state"))+" · 原因："+Json.Get(row,"reasonCode"),"目录："+Json.Get(catalog,"source","未知")+" · "+ActivityData.TimeText(Json.Get(catalog,"checkedAt"))+" · 时效 "+Json.Get(catalog,"freshness","未知"),"上下文："+DiagnosticsUi.State(Json.Get(row,"contextFit"))+"；输出："+DiagnosticsUi.State(Json.Get(row,"outputFit")),"能力证据："+string.Join("；",new[]{"tools","multimodal","stream","contextWindow","outputCapacity"}.Where(caps.ContainsKey).Select(k=>k+"="+(caps[k]==null?"未知":Convert.ToString(caps[k]))))};var audit=NvidiaPresentation.Object(row,"audit");lines.Add("历史体检（独立证据，非当前请求验收）："+DiagnosticsUi.State(Json.Get(audit,"status"))+" · "+ActivityData.TimeText(Json.Get(audit,"checkedAt")));foreach(var test in Json.Rows(audit,"tests"))lines.Add("  "+Json.Get(test,"stage")+"："+(object.Equals(test.ContainsKey("ok")?test["ok"]:null,true)?"通过":object.Equals(test.ContainsKey("ok")?test["ok"]:null,false)?"未通过":"未知")+" · "+Json.Get(test,"errorCode"));lines.AddRange(Json.Strings(row,"notes"));details.Text=string.Join(Environment.NewLine,lines);}
    }
    internal sealed class RouteTargetsForm : ProductForm {
        private readonly List<Dictionary<string,object>> targets;private readonly DataGridView grid=DiagnosticsUi.Grid("优先级","上游","模型");private readonly TextBox preview=DiagnosticsUi.Output("保存前后路由顺序");private readonly Button up=Theme.Button("上移"),down=Theme.Button("下移"),save=Theme.Button("保存此顺序");private bool binding;internal Dictionary<string,object>[] OriginalTargets {get;private set;}internal Dictionary<string,object>[] Targets {get{return targets.ToArray();}}
        internal RouteTargetsForm(Dictionary<string,object> route){Text="路由优先级 · "+Json.Get(route,"name",Json.Get(route,"id"));Size=new Size(1020,760);MinimumSize=new Size(700,600);StartPosition=FormStartPosition.CenterParent;Font=Theme.Body;BackColor=Theme.Background;Padding=new Padding(DiagnosticsUi.Inset);OriginalTargets=Json.Rows(Json.Object(Json.Text(route)),"targets").ToArray();targets=Json.Rows(Json.Object(Json.Text(route)),"targets").ToList();var toolbar=DiagnosticsUi.Toolbar();toolbar.Controls.Add(up);toolbar.Controls.Add(down);toolbar.Controls.Add(save);var cancel=Theme.Button("取消");toolbar.Controls.Add(cancel);up.Click+=(s,e)=>MoveTarget(-1);down.Click+=(s,e)=>MoveTarget(1);save.BackColor=Theme.Accent;save.ForeColor=Color.White;save.Click+=(s,e)=>DialogResult=DialogResult.OK;cancel.Click+=(s,e)=>DialogResult=DialogResult.Cancel;CancelButton=cancel;grid.CurrentCellChanged+=(s,e)=>{if(!binding)SyncButtons();};var split=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1000,560),SplitterDistance=270,Panel1MinSize=100,Panel2MinSize=100};split.Panel1.Controls.Add(grid);split.Panel2.Controls.Add(preview);split.Panel2.Padding=new Padding(12);split.Panel2.BackColor=Theme.Surface;Controls.Add(split);Controls.Add(toolbar);Controls.Add(DiagnosticsUi.Hint("上移 / 下移只改变原 targets 的优先级，保留所有目标字段。保存时核对原顺序；若配置已变更，刷新后重新编辑。"));Bind(0);}
        private void MoveTarget(int delta){if(grid.CurrentRow==null)return;int index=grid.CurrentRow.Index,next=index+delta;if(next<0||next>=targets.Count)return;var row=targets[index];targets.RemoveAt(index);targets.Insert(next,row);Bind(next);}
        private static string Chain(IEnumerable<Dictionary<string,object>> values){return string.Join(Environment.NewLine,values.Select((r,i)=>(i+1)+". "+Json.Get(r,"upstreamId")+" / "+Json.Get(r,"model")));}
        private void Bind(int selected){binding=true;try{grid.Rows.Clear();for(int i=0;i<targets.Count;i++)grid.Rows.Add(i+1,Json.Get(targets[i],"upstreamId"),Json.Get(targets[i],"model"));if(targets.Count>0)grid.CurrentCell=grid.Rows[Math.Max(0,Math.Min(targets.Count-1,selected))].Cells[0];preview.Text="保存前"+Environment.NewLine+Chain(OriginalTargets)+Environment.NewLine+Environment.NewLine+"保存后"+Environment.NewLine+Chain(targets);}finally{binding=false;SyncButtons();}}
        private void SyncButtons(){int index=grid.CurrentRow==null?-1:grid.CurrentRow.Index;up.Enabled=index>0;down.Enabled=index>=0&&index+1<targets.Count;save.Enabled=targets.Count>0&&Json.Text(OriginalTargets)!=Json.Text(targets);}
    }

    // 第 6 页组件：只读展示本网关自身记录的活动元数据（请求 + 领取）。
    // 不发起任何后台模型调用；不展示请求正文、参数或文件路径；构造函数不做网络请求。
    internal sealed class ActivityBoard : Panel {
        private readonly Gateway backend;
        private readonly Label title;
        private readonly Label subtitle;
        private readonly Label status;
        private readonly FlowLayoutPanel toolbar;
        private readonly Button rangeDay;
        private readonly Button rangeWeek;
        private readonly Button rangeMonth;
        private readonly Button rangeAll;
        private readonly TextBox search;
        private readonly ComboBox sourceBox;
        private readonly ComboBox modelBox;
        private readonly CheckBox detailToggle;
        private readonly Panel upper;
        private readonly ActivityFacts facts;
        private readonly ActivityChart chart;
        private readonly ActivityDetail detail;
        private readonly DataGridView grid;
        private Dictionary<string, object> data;
        private bool stale, suppress, laying, loading;
        private string range = "24h";

        internal ActivityBoard(Gateway backend) {
            this.backend = backend;
            DoubleBuffered = true; BackColor = Theme.Background; AutoScroll=true;
            AccessibleRole = AccessibleRole.Grouping; AccessibleName = "模型活动看板";
            AccessibleDescription = "展示本网关记录的请求与领取元数据；不自动请求，激活本页时才读取。";

            title = new Label { Text = "模型活动看板", Font = Theme.Title, ForeColor = Theme.Ink, BackColor = Color.Transparent, AutoSize = true };
            subtitle = new Label {
                Text = "本网关记录的请求与领取时间轴。输入组成是字符 ÷ 4 估算，非官方计费 Token；工具活动仅表示上下文携带，不证明执行完成。",
                Font = Theme.Body, ForeColor = Theme.Muted, BackColor = Color.Transparent, AutoSize = true
            };

            toolbar = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, FlowDirection = FlowDirection.LeftToRight, BackColor = Color.Transparent, Margin = Padding.Empty };
            rangeDay = Theme.Button("近 24 小时"); rangeDay.AccessibleName = "查看近 24 小时";
            rangeWeek = Theme.Button("近 7 天"); rangeWeek.AccessibleName = "查看近 7 天";
            rangeMonth = Theme.Button("近 30 天"); rangeMonth.AccessibleName = "查看近 30 天";
            rangeAll = Theme.Button("累计全部"); rangeAll.AccessibleName = "查看累计全部记录";
            var refresh = Theme.Button("刷新"); refresh.AccessibleName = "刷新活动数据";
            search = new TextBox { Width = 150, Font = Theme.Body, BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(6, 9, 8, 8), AccessibleName = "搜索文本", AccessibleDescription = "按文本过滤请求与领取记录" };
            sourceBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 132, Font = Theme.Body, Margin = new Padding(6, 7, 8, 8), AccessibleName = "来源筛选" };
            modelBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 150, Font = Theme.Body, Margin = new Padding(6, 7, 8, 8), AccessibleName = "模型筛选" };
            var apply = Theme.Button("应用筛选"); apply.AccessibleName = "应用筛选并重新加载";
            detailToggle = new CheckBox { Text = "显示详情", Checked = true, AutoSize = true, Font = Theme.Body, ForeColor = Theme.Ink, Margin = new Padding(10, 11, 6, 8), AccessibleName = "显示选中行详情" };
            rangeDay.Click += async delegate { range = "24h"; SyncRange(); await LoadAsync(); };
            rangeWeek.Click += async delegate { range = "7d"; SyncRange(); await LoadAsync(); };
            rangeMonth.Click += async delegate { range = "30d"; SyncRange(); await LoadAsync(); };
            rangeAll.Click += async delegate { range = "all"; SyncRange(); await LoadAsync(); };
            refresh.Click += async delegate { await LoadAsync(); };
            apply.Click += async delegate { await LoadAsync(); };
            detailToggle.CheckedChanged += delegate { LayoutBoard(); };
            toolbar.Controls.Add(rangeDay); toolbar.Controls.Add(rangeWeek); toolbar.Controls.Add(rangeMonth); toolbar.Controls.Add(rangeAll); toolbar.Controls.Add(refresh);
            toolbar.Controls.Add(new Label{Text="搜索",AutoSize=true,ForeColor=Theme.Muted,Margin=new Padding(2,11,2,8)}); toolbar.Controls.Add(search); toolbar.Controls.Add(sourceBox); toolbar.Controls.Add(modelBox); toolbar.Controls.Add(apply); toolbar.Controls.Add(detailToggle);

            status = new Label {
                Text = "尚未加载：切换到本页或点击刷新时读取（默认不自动请求后台）。",
                Font = Theme.Body, ForeColor = Theme.Muted, BackColor = Color.Transparent, AutoSize = false, AutoEllipsis = true,
                AccessibleRole = AccessibleRole.StaticText, AccessibleName = "活动数据状态"
            };

            upper = new Panel { BackColor = Color.Transparent };
            facts = new ActivityFacts(); chart = new ActivityChart();
            upper.Controls.Add(facts); upper.Controls.Add(chart);
            detail = new ActivityDetail();

            grid = Theme.Grid("时间", "来源", "模型", "结果", "Token", "接力");
            grid.Dock = DockStyle.None;
            grid.AccessibleName = "请求与领取时间轴";
            grid.AccessibleDescription = "每行一条本网关记录：请求项含尝试与工具上下文摘要；领取项不计入请求数。";
            grid.SelectionChanged += delegate { PresentSelection(); };
            grid.CellFormatting += delegate(object sender, DataGridViewCellFormattingEventArgs ev) {
                if (ev.ColumnIndex != 3 || ev.Value == null) return;
                string text = Convert.ToString(ev.Value, System.Globalization.CultureInfo.InvariantCulture);
                if (text == "成功" || text == "已领取" || text == "已观察到") ev.CellStyle.ForeColor = Theme.Success;
                else if (text == "失败") ev.CellStyle.ForeColor = Theme.Danger;
                else if (text == "进行中") ev.CellStyle.ForeColor = Theme.Warning;
            };

            Controls.Add(grid); Controls.Add(upper); Controls.Add(detail); Controls.Add(status); Controls.Add(toolbar); Controls.Add(subtitle); Controls.Add(title);
            SyncRange();
            LayoutBoard();
        }

        // 由 MainWindow 在第 6 页激活时调用；本组件自身不在构造/显示时自动请求。
        internal async Task LoadAsync() {
            if (loading) return;
            loading = true;
            try {
                if (backend == null) { SetState("error", "未连接到本机后台服务，无法读取活动数据。"); return; }
                SetState("loading", "正在读取本网关活动数据…（仅 GET，不执行模型调用）");
                string path = "/admin/activity-context?range=" + range + "&limit=200";
                string text = search.Text == null ? "" : search.Text.Trim();
                if (text.Length > 0) path += "&search=" + Uri.EscapeDataString(text);
                if (sourceBox.SelectedIndex > 0) path += "&source=" + Uri.EscapeDataString(Convert.ToString(sourceBox.SelectedItem, System.Globalization.CultureInfo.InvariantCulture));
                if (modelBox.SelectedIndex > 0) path += "&model=" + Uri.EscapeDataString(Convert.ToString(modelBox.SelectedItem, System.Globalization.CultureInfo.InvariantCulture));
                var result = await backend.Request("GET", path);
                Present(result);
            } catch (Exception x) {
                bool kept = data != null;
                stale = kept;
                if (kept) { facts.Bind(data); chart.Bind(data); }
                SetState("error", "读取活动数据失败：" + x.Message + (kept ? "（保留上次数据，已标记为旧数据）" : "（当前无数据）"));
                if (kept) AccessibleDescription = "读取失败，仍显示上次数据（旧数据）。" + facts.Summary();
            } finally { loading = false; }
        }

        // 离线 fixture 入口：直接呈现给定 payload，不做任何网络请求。
        internal void Present(Dictionary<string, object> value) {
            if (value == null) { SetState("empty", "没有可呈现的活动数据（空 payload）。"); return; }
            data = value; stale = false;
            facts.Bind(value); chart.Bind(value);
            FillGrid(value);
            SyncFilters(value);
            string coverage = Json.Get(ActivityData.Child(value, "coverage"), "note", "");if(object.Equals(ActivityData.Child(value,"coverage").ContainsKey("truncated")?ActivityData.Child(value,"coverage")["truncated"]:false,true))coverage="记录已截断 · "+coverage;
            string generated = Json.Get(value, "generatedAt", "");
            var items = Json.Rows(value, "items").ToArray();
            string head = "范围 " + RangeText() + (generated.Length > 0 ? " · 生成于 " + ActivityData.TimeText(generated) : "") + (coverage.Length > 0 ? " · " + coverage : "");
            if (items.Length == 0) SetState("empty", "本网关在所选范围内没有请求或领取记录。" + head);
            else SetState("ready", "已加载 " + items.Length + " 条记录。" + head);
            AccessibleDescription = "范围 " + RangeText() + "。" + facts.Summary() + " " + chart.Summary() + " 数据来源：本网关 /admin/activity-context；不展示请求正文、参数与文件路径。";
        }

        internal bool IsStale { get { return stale; } }
        internal string State { get { return state; } }
        private string state = "idle";

        private static readonly string[] RangeKeys = { "24h", "7d", "30d", "all" };
        private static readonly string[] RangeLabels = { "近 24 小时", "近 7 天", "近 30 天", "累计全部" };

        private string RangeText() {
            int index = Array.IndexOf(RangeKeys, range);
            return index >= 0 ? RangeLabels[index] : "近 24 小时";
        }

        // One loop over the four buttons keeps label, colour and accessibility in
        // step; four hand-written pairs is where a fifth range would get missed.
        private void SyncRange() {
            var buttons = new[] { rangeDay, rangeWeek, rangeMonth, rangeAll };
            for (int i = 0; i < buttons.Length; i++) {
                bool active = range == RangeKeys[i];
                buttons[i].BackColor = active ? Theme.Accent : Theme.Surface;
                buttons[i].ForeColor = active ? Color.White : Theme.Ink;
                buttons[i].Invalidate();
                buttons[i].AccessibleDescription = active ? "当前范围：" + RangeLabels[i] : "切换到" + RangeLabels[i];
            }
        }

        private void SetState(string kind, string text) {
            state = kind;
            status.Text = text;
            status.ForeColor = kind == "error" ? Theme.Danger : kind == "loading" ? Theme.Accent : kind == "empty" ? Theme.Warning : Theme.Muted;
            status.AccessibleDescription = "状态 " + kind + "；" + text;
        }

        private void FillGrid(Dictionary<string, object> value) {
            suppress = true;
            try {
                grid.Rows.Clear();
                var items = Json.Rows(value, "items").Concat(Json.Rows(value, "claims")).ToArray();
                foreach (var item in items) {
                    string kind = Json.Get(item, "kind", "request");
                    bool claim = kind == "claim";
                    string model = claim ? "未返回" : Json.Get(item, "model", "未返回");
                    if (!claim && model.Length == 0) model = "未返回";
                    string token = "未返回";
                    if (!claim) {
                        string known = ActivityData.Tokens(item, "knownTokens");
                        string estimated = ActivityData.Tokens(item, "estimatedInputTokens");
                        token = known + (estimated == "未返回" ? "" : " · 估 " + estimated);
                    }
                    int index = grid.Rows.Add(new object[] {
                        ActivityData.TimeText(Json.Get(item, "time")),
                        Json.Get(item, "source", "未返回"),
                        model,
                        ActivityData.ResultName(Json.Get(item, "status")),
                        token,
                        claim ? "未返回" : ActivityData.Number(item, "relays")
                    });
                    grid.Rows[index].Tag = item;
                }
                grid.ClearSelection();
            } finally { suppress = false; }
            PresentSelection();
        }

        private void SyncFilters(Dictionary<string, object> value) {
            string currentSource = sourceBox.SelectedIndex > 0 ? Convert.ToString(sourceBox.SelectedItem, System.Globalization.CultureInfo.InvariantCulture) : null;
            string currentModel = modelBox.SelectedIndex > 0 ? Convert.ToString(modelBox.SelectedItem, System.Globalization.CultureInfo.InvariantCulture) : null;
            sourceBox.Items.Clear(); sourceBox.Items.Add("全部来源");
            foreach (string item in Json.Strings(value, "sources")) sourceBox.Items.Add(item);
            sourceBox.SelectedIndex = currentSource != null && sourceBox.Items.Contains(currentSource) ? sourceBox.Items.IndexOf(currentSource) : 0;
            modelBox.Items.Clear(); modelBox.Items.Add("全部模型");
            foreach (string item in Json.Strings(value, "models")) modelBox.Items.Add(item);
            modelBox.SelectedIndex = currentModel != null && modelBox.Items.Contains(currentModel) ? modelBox.Items.IndexOf(currentModel) : 0;
        }

        private void PresentSelection() {
            if (suppress) return;
            if (grid.SelectedRows.Count == 0) { detail.Bind(null); return; }
            detail.Bind(grid.SelectedRows[0].Tag as Dictionary<string, object>);
        }

        protected override void OnResize(EventArgs e) { base.OnResize(e); LayoutBoard(); }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); LayoutBoard(); }

        // 命名 metrics 布局：宽屏并排、窄屏上下排，任何宽度下区块都不重叠。
        private void LayoutBoard() {
            if (laying || title==null) return;
            laying = true;
            try {
                float scale = UiMetrics.Scale(this);
                int pad = (int)(Theme.Padding * scale), gap = (int)(14 * scale);
                int avail = Math.Max((int)(300 * scale), ClientSize.Width - pad * 2 - SystemInformation.VerticalScrollBarWidth);
                int y = pad + AutoScrollPosition.Y;
                title.Location = new Point(pad, y);
                y += title.Height + (int)(4 * scale);
                subtitle.MaximumSize = new Size(avail, 0);
                subtitle.Location = new Point(pad, y);
                y += subtitle.PreferredHeight + (int)(10 * scale);
                toolbar.MaximumSize = new Size(avail, 0);
                toolbar.PerformLayout();
                toolbar.Location = new Point(pad, y);
                int toolbarHeight = toolbar.Height;
                y += toolbarHeight + (int)(8 * scale);
                status.Location = new Point(pad, y);
                status.Size = new Size(avail, (int)(22 * scale));
                y += status.Height + (int)(10 * scale);

                int upperTop = y;
                bool sideBySide = avail / scale >= 740f;
                int factsWidth = sideBySide ? (avail - gap) / 2 : avail;
                int chartWidth = sideBySide ? avail - factsWidth - gap : avail;
                int factsHeight = facts.Measure(factsWidth);
                int chartHeight = sideBySide ? factsHeight : (int)(214 * scale);
                upper.Location = new Point(pad, upperTop);
                upper.Size = new Size(avail, sideBySide ? factsHeight : factsHeight + gap + chartHeight);
                facts.Bounds = new Rectangle(0, 0, factsWidth, factsHeight);
                chart.Bounds = sideBySide ? new Rectangle(factsWidth + gap, 0, chartWidth, chartHeight) : new Rectangle(0, factsHeight + gap, chartWidth, chartHeight);

                int detailHeight = detailToggle.Checked ? (int)(220 * scale) : 0;
                int gridTop = upperTop + upper.Height + gap;
                int gridHeight = Math.Max((int)(220*scale),ClientSize.Height-pad-gridTop-detailHeight-(detailHeight>0?gap:0));
                grid.Bounds = new Rectangle(pad, gridTop, avail, gridHeight);
                detail.Visible=detailToggle.Checked;
                detail.Bounds=new Rectangle(pad,gridTop+gridHeight+gap,avail,detailHeight);
                AutoScrollMinSize=new Size(0,gridTop-AutoScrollPosition.Y+gridHeight+(detailHeight>0?gap+detailHeight:0)+pad);
            } finally { laying = false; }
        }
    }

    // 统计带 + 五段输入组成：窄屏自动改用 2 列 KPI 与单行文字，条形图只在宽屏绘制。
    internal sealed class ActivityFacts : Control {
        private static readonly string[] KpiNames = { "请求", "尝试", "成功", "失败", "接力", "已知 Token", "估算输入 Token", "未知 Token 尝试" };
        private static readonly string[] KpiKeys = { "requests", "attempts", "success", "failed", "relays", "knownTokens", "estimatedInputTokens", "unknownTokenAttempts" };
        private static readonly string[] PartNames = { "system", "user", "assistant", "toolSchemas", "toolResults" };
        private Dictionary<string, object> data;

        internal ActivityFacts() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Surface; AccessibleRole = AccessibleRole.Chart; AccessibleName = "请求统计与输入组成估算";
        }
        internal void Bind(Dictionary<string, object> value) { data = value; AccessibleDescription = Summary(); Invalidate(); }

        internal string Summary() {
            var kpis = ActivityData.Child(data, "kpis");
            var composition = ActivityData.Child(data, "composition");
            var text = new StringBuilder();
            text.Append("请求 ").Append(ActivityData.Number(kpis, "requests"));
            text.Append("，尝试 ").Append(ActivityData.Number(kpis, "attempts"));
            text.Append("，成功 ").Append(ActivityData.Number(kpis, "success"));
            text.Append("，失败 ").Append(ActivityData.Number(kpis, "failed"));
            text.Append("，接力 ").Append(ActivityData.Number(kpis, "relays"));
            text.Append("；已知 Token ").Append(ActivityData.Number(kpis, "knownTokens"));
            text.Append("，估算输入 Token ").Append(ActivityData.Number(kpis, "estimatedInputTokens"));
            text.Append("，未知 Token 尝试 ").Append(ActivityData.Number(kpis, "unknownTokenAttempts"));
            text.Append("；输入组成（字符）system ").Append(ActivityData.Number(ActivityData.Child(composition, "system"), "chars"));
            text.Append("、user ").Append(ActivityData.Number(ActivityData.Child(composition, "user"), "chars"));
            text.Append("、assistant ").Append(ActivityData.Number(ActivityData.Child(composition, "assistant"), "chars"));
            text.Append("、toolSchemas ").Append(ActivityData.Number(ActivityData.Child(composition, "toolSchemas"), "chars"));
            text.Append("、toolResults ").Append(ActivityData.Number(ActivityData.Child(composition, "toolResults"), "chars"));
            text.Append("。字符 ÷ 4 为估算，非官方计费 Token。");
            return text.ToString();
        }

        internal int Measure(int width) {
            float scale = UiMetrics.Scale(this);
            int columns = width / scale < 560f ? 2 : 4;
            int rows = (KpiNames.Length + columns - 1) / columns;
            return (int)((14 + 26 + rows * 64 + 16 + 26 + PartNames.Length * 26 + 34 + 8) * scale);
        }

        protected override void OnPaint(PaintEventArgs e) {
            if (ClientSize.Width <= 4 || ClientSize.Height <= 4) return;
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            float scale = g.DpiX / 96f; g.ScaleTransform(scale, scale);
            float w = Width / scale, h = Height / scale;
            UiMetrics.Card(g, new RectangleF(0.5f, 0.5f, w - 1, h - 1), 12);
            var kpis = ActivityData.Child(data, "kpis");
            var composition = ActivityData.Child(data, "composition");
            float y = 14f;
            UiMetrics.Text(g, "请求与尝试统计（本网关记录）", 14, Theme.Ink, new RectangleF(18, y, w - 36, 24), true);
            y += 26f;
            int columns = w < 560f ? 2 : 4;
            int rows = (KpiNames.Length + columns - 1) / columns;
            float cellWidth = (w - 36f) / columns, cellHeight = 64f;
            for (int i = 0; i < KpiNames.Length; i++) {
                var cell = new RectangleF(18 + (i % columns) * cellWidth, y + (i / columns) * cellHeight, cellWidth - 10f, cellHeight - 10f);
                UiMetrics.Box(g, cell, Theme.Soft, 10);
                UiMetrics.Text(g, KpiNames[i], 11, Theme.Muted, new RectangleF(cell.X + 12, cell.Y + 8, cell.Width - 24, 18));
                string kpiValue = KpiKeys[i].IndexOf("Tokens", StringComparison.Ordinal) >= 0 ? ActivityData.Tokens(kpis, KpiKeys[i]) : ActivityData.Number(kpis, KpiKeys[i]);
                UiMetrics.Text(g, kpiValue, 19, Theme.Ink, new RectangleF(cell.X + 12, cell.Y + 26, cell.Width - 24, 28), true, "Segoe UI");
            }
            y += rows * cellHeight + 16f;
            UiMetrics.Text(g, "输入组成（字符 → 估算 Token）", 14, Theme.Ink, new RectangleF(18, y, w - 36, 24), true);
            y += 26f;
            long peak = 1;
            foreach (string part in PartNames) {
                var segment = ActivityData.Child(composition, part);
                long tokens = ActivityData.Int(segment, "estimatedTokens", -1);
                if (tokens > peak) peak = tokens;
            }
            bool narrow = w < 560f;
            for (int i = 0; i < PartNames.Length; i++) {
                var segment = ActivityData.Child(composition, PartNames[i]);
                string chars = ActivityData.Number(segment, "chars");
                string tokensText = ActivityData.Tokens(segment, "estimatedTokens");
                float row = y + i * 26f;
                if (narrow) {
                    UiMetrics.Text(g, PartNames[i] + " · " + chars + " 字符 · ≈ " + tokensText + " Token", 11, Theme.Muted, new RectangleF(18, row, w - 36, 20));
                    continue;
                }
                UiMetrics.Text(g, PartNames[i], 11, Theme.Muted, new RectangleF(18, row, 112, 20), false, "Consolas");
                UiMetrics.Text(g, chars + " 字符", 11, Theme.Ink, new RectangleF(132, row, 104, 20), false, "Segoe UI");
                UiMetrics.Text(g, "≈ " + tokensText + " Token", 11, Theme.Ink, new RectangleF(238, row, 116, 20), false, "Segoe UI");
                var track = new RectangleF(360, row + 5f, Math.Max(40f, w - 396f), 10f);
                UiMetrics.Box(g, track, Theme.Soft, 5);
                long tokens = ActivityData.Int(segment, "estimatedTokens", 0);
                if (tokens > 0) {
                    float fraction = (float)tokens / peak;
                    UiMetrics.Box(g, new RectangleF(track.X, track.Y, Math.Max(3f, track.Width * fraction), track.Height), Theme.Accent, 5);
                }
            }
            float foot = y + PartNames.Length * 26f + 2f;
            UiMetrics.Text(g, "输入组成是字符/4估算，非官方计费 Token；工具活动仅上下文携带，不证明执行完成。", 10, Theme.Muted, new RectangleF(18, foot, w - 36, Math.Min(34f, h - foot - 4f)));
        }
    }

    // 近 7 日网关请求柱图（次数，不是计费或用户完成的工作量）。
    internal sealed class ActivityChart : Control {
        private Dictionary<string, object> data;

        internal ActivityChart() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Surface; AccessibleRole = AccessibleRole.Chart; AccessibleName = "网关请求柱状图";
        }
        internal void Bind(Dictionary<string, object> value) { data = value; AccessibleDescription = Summary(); Invalidate(); }

        // Both helpers run from OnPaint before any data has arrived, so they must
        // tolerate data == null: Json.Get dereferences its dictionary and threw
        // NullReferenceException, which WinForms painted as the red cross.
        private int BucketDays() {
            if (data == null) return 7;
            int days = ActivityData.Int(data, "bucketDays", 7);
            return days == 30 ? 30 : 7;
        }

        private string RangeLabel() {
            if (data == null) return "近 7 日";
            string value = Json.Get(data, "range", "24h");
            if (value == "30d") return "近 30 天";
            if (value == "all") return "累计全部（仅近 30 天按日）";
            return "近 7 日";
        }

        internal string Summary() {
            var rows = data == null ? new Dictionary<string, object>[0] : Json.Rows(data, "daily").ToArray();
            var text = new StringBuilder(RangeLabel() + "网关请求次数：");
            if (rows.Length == 0) text.Append("暂无记录。");
            else {
                foreach (var row in rows) text.Append(Json.Get(row, "date", "未知日期")).Append(" ").Append(ActivityData.Number(row, "requests")).Append(" 次；");
                text.Append("仅本网关记录，不含绕过调用，不代表计费。");
            }
            return text.ToString();
        }

        protected override void OnPaint(PaintEventArgs e) {
            if (ClientSize.Width <= 4 || ClientSize.Height <= 4) return;
            var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Theme.Surface);
            float scale = g.DpiX / 96f; g.ScaleTransform(scale, scale);
            float w = Width / scale, h = Height / scale;
            UiMetrics.Card(g, new RectangleF(0.5f, 0.5f, w - 1, h - 1), 12);
            var kpis = ActivityData.Child(data, "kpis");
            UiMetrics.Text(g, RangeLabel() + "网关请求次数", 14, Theme.Ink, new RectangleF(18, 10, w - 36, 24), true);
            UiMetrics.Text(g, "仅本网关记录，不含绕过调用；次数不代表计费或用户完成的工作。", 10, Theme.Muted, new RectangleF(18, 32, w - 36, 20));
            if (w >= 320f) {
                float legendX = 18f;
                UiMetrics.Box(g, new RectangleF(legendX, 59, 8, 8), Theme.Accent, 4);
                UiMetrics.Text(g, "成功", 10, Theme.Muted, new RectangleF(legendX + 13, 53, 42, 20));
                UiMetrics.Box(g, new RectangleF(legendX + 58, 59, 8, 8), Theme.Danger, 4);
                UiMetrics.Text(g, "失败", 10, Theme.Muted, new RectangleF(legendX + 71, 53, 42, 20));
                UiMetrics.Box(g, new RectangleF(legendX + 116, 59, 8, 8), UiMetrics.AccentMid, 4);
                UiMetrics.Text(g, "其他", 10, Theme.Muted, new RectangleF(legendX + 129, 53, 42, 20));
                UiMetrics.Text(g, "合计 " + (data==null?0:Json.Rows(data,"daily").Sum(d=>ActivityData.Int(d,"requests",0))) + " 次", 10, Theme.Muted, new RectangleF(legendX + 174, 53, 126, 20));
            }
            var rows = data == null ? new Dictionary<string, object>[0] : Json.Rows(data, "daily").ToArray();
            int buckets = BucketDays();
            var plot = new RectangleF(48, 84, Math.Max(40f, w - 68f), Math.Max(52f, h - 130f));
            int peak = 1;
            foreach (var row in rows) { int value = ActivityData.Int(row, "requests", 0); if (value > peak) peak = value; }
            peak = Math.Max(4, (int)(Math.Ceiling(peak / 4.0) * 4));
            for (int i = 0; i <= 4; i++) {
                float lineY = plot.Y + plot.Height * i / 4f;
                using (var pen = new Pen(UiMetrics.Line)) g.DrawLine(pen, plot.X, lineY, plot.Right, lineY);
                UiMetrics.Text(g, (peak - peak * i / 4).ToString(System.Globalization.CultureInfo.InvariantCulture), 9, Theme.Muted, new RectangleF(6, lineY - 8, 36, 16), false, "Segoe UI", StringAlignment.Far);
            }
            float slot = plot.Width / buckets;
            int offset = Math.Max(0, buckets - rows.Length);
            // 30 buckets leave too little room for a centred label under every bar.
            bool labelEveryBucket = buckets <= 7;
            for (int i = 0; i < buckets; i++) {
                int index = i - offset;
                var row = index >= 0 && index < rows.Length ? rows[index] : null;
                float barWidth = slot * 0.46f, centerX = plot.X + slot * i + slot / 2f;
                int total = row == null ? 0 : ActivityData.Int(row, "requests", 0);
                int succeeded = row == null ? 0 : ActivityData.Int(row, "success", 0);
                int failed = row == null ? 0 : ActivityData.Int(row, "failed", 0);
                int other = Math.Max(0, total - succeeded - failed);
                float full = plot.Height * total / peak;
                var bar = new RectangleF(centerX - barWidth / 2f, plot.Bottom - full, barWidth, full);
                float cursor = plot.Bottom;
                float successHeight = plot.Height * succeeded / peak, failedHeight = plot.Height * failed / peak, otherHeight = plot.Height * other / peak;
                if (successHeight > 0) { UiMetrics.Box(g, new RectangleF(bar.X, cursor - successHeight, barWidth, successHeight), Theme.Accent, 6); cursor -= successHeight; }
                if (failedHeight > 0) { UiMetrics.Box(g, new RectangleF(bar.X, cursor - failedHeight, barWidth, failedHeight), Theme.Danger, 6); cursor -= failedHeight; }
                if (otherHeight > 0) { UiMetrics.Box(g, new RectangleF(bar.X, cursor - otherHeight, barWidth, otherHeight), UiMetrics.AccentMid, 6); cursor -= otherHeight; }
                if (row != null && (labelEveryBucket || i == buckets - 1 || i % 5 == 0)) {
                    string label = ActivityData.DayLabel(Json.Get(row, "date"));
                    if (label.Length > 0) UiMetrics.Text(g, label, 9, Theme.Muted, new RectangleF(centerX - Math.Max(slot, 28f) / 2f, plot.Bottom + 4, Math.Max(slot, 28f), 16), false, "Segoe UI", StringAlignment.Center);
                }
                if (total > 0) UiMetrics.Text(g, total.ToString(System.Globalization.CultureInfo.InvariantCulture), 10, Theme.Ink, new RectangleF(centerX - slot / 2f, bar.Y - 20f, slot, 18), false, "Segoe UI", StringAlignment.Center);
            }
            if (rows.Length == 0) UiMetrics.Text(g, "暂无请求记录（本网关 " + RangeLabel() + "）", 12, Theme.Muted, new RectangleF(plot.X, plot.Y + plot.Height / 2f - 12f, plot.Width, 24), false, "Microsoft YaHei UI", StringAlignment.Center);
        }
    }

    // 选中行详情：只读元数据摘要（尝试、工具名、文件活动计数、切换原因），不打印请求正文/参数/路径。
    internal sealed class ActivityDetail : Panel {
        private Dictionary<string, object> item;private readonly TextBox output=Theme.Output();

        internal ActivityDetail() {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Surface; AccessibleRole = AccessibleRole.StaticText; AccessibleName = "选中行详情";Padding=new Padding(14);output.Dock=DockStyle.Fill;output.ScrollBars=ScrollBars.Vertical;output.AccessibleName="完整请求元数据详情";Controls.Add(output);
        }
        internal void Bind(Dictionary<string, object> value) {
            item = value;
            var lines = Lines();
            AccessibleDescription = lines.Count > 1 ? string.Join(" ", lines.Skip(1).ToArray()) : lines[0];output.Text=string.Join(Environment.NewLine,lines);
            Invalidate();
        }

        private List<string> Lines() {
            var lines = new List<string>();
            if (item == null) {
                lines.Add("详情");
                lines.Add("在上方时间轴选择一行：这里显示尝试次数、工具名、文件活动计数与切换原因。");
                lines.Add("不展示请求正文、参数与文件路径；工具活动只表示上下文携带，不证明执行完成。");
                return lines;
            }
            string kind = Json.Get(item, "kind", "request");
            lines.Add("详情 · " + Json.Get(item, "id", "未返回") + "（" + (kind == "claim" ? "领取记录" : "网关请求") + "）");
            lines.Add("时间 " + ActivityData.TimeText(Json.Get(item, "time")) + " · 来源 " + Json.Get(item, "source", "未返回") + " · 结果 " + ActivityData.ResultName(Json.Get(item, "status")));
            if (kind == "relay") {lines.Add("模型接力事件 · "+Json.Get(item,"fromPlatform")+" → "+Json.Get(item,"toPlatform"));lines.Add("切换原因："+Json.Get(item,"relayReason"));lines.Add("不是领取或签到记录，不代表请求已经成功。");return lines;}
            if (kind == "claim") {
                lines.Add("平台 " + Json.Get(item, "platform", "未返回") + " · 任务 " + Json.Get(item, "task", "未返回"));
                lines.Add("领取记录由调度器观察，不计入请求数，也不代表模型调用。");
                return lines;
            }
            lines.Add("模型 " + Json.Get(item, "model", "未返回") + " · 路由别名 " + Json.Get(item, "routeId", "未返回") + " · 接力 " + ActivityData.Number(item, "relays") + " · 已知 Token " + ActivityData.Tokens(item, "knownTokens") + " · 估算输入 Token " + ActivityData.Tokens(item, "estimatedInputTokens"));
            var context = ActivityData.Child(item, "context");
            foreach(string part in new[]{"system","user","assistant","toolSchemas","toolResults"}){var section=ActivityData.Child(ActivityData.Child(context,"composition"),part);lines.Add(part+" · "+ActivityData.Number(section,"chars")+" 字符 · 估算 "+ActivityData.Tokens(section,"estimatedTokens")+" Token");}
            lines.Add("工具名：" + ActivityData.Join(Json.Strings(context, "toolNames")));
            var fileActivity = ActivityData.Child(context, "fileActivity");
            lines.Add("文件活动计数：读 " + ActivityData.Number(fileActivity, "read") + " · 写 " + ActivityData.Number(fileActivity, "write") + " · 搜索 " + ActivityData.Number(fileActivity, "search") + " · 其他 " + ActivityData.Number(fileActivity, "other"));
            lines.Add("证据级别：" + Json.Get(context, "evidence", "未返回") + "；工具活动仅上下文携带，不证明执行完成。");
            var attempts = Json.Rows(item, "attempts").ToArray();
            if (attempts.Length == 0) lines.Add("尝试记录：未返回");
            foreach (var attempt in attempts) {
                lines.Add("尝试 " + ActivityData.Number(attempt, "attempt") + " · " + Json.Get(attempt, "platform", "未返回") + " · " + Json.Get(attempt, "model", "未返回") + " · " + ActivityData.ResultName(Json.Get(attempt, "status")) + " · " + ActivityData.Number(attempt, "durationMs") + " ms");
                lines.Add("    错误码 " + Json.Get(attempt, "errorCode", "未返回") + " · 切换原因 " + Json.Get(attempt, "relayReason", "未返回"));
            }
            return lines;
        }

    }
}

namespace AiCreditDesktop {
    internal static class GatewayTools {
        internal static Dictionary<string,object> RelayBody(bool enabled,decimal reservePercent,decimal reserveCredits){if(reservePercent<0||reservePercent>50||reserveCredits<0||reserveCredits>100000)throw new InvalidOperationException("请检查接力预留阈值");return new Dictionary<string,object>{{"enabled",enabled},{"reservePercent",reservePercent},{"reserveCredits",reserveCredits}};}
        internal static Dictionary<string,object> ProviderBody(string providerId,string id,string file,string[] models){if(string.IsNullOrWhiteSpace(providerId)||string.IsNullOrWhiteSpace(id))throw new InvalidOperationException("请选择平台并填写账号 ID");if(!string.IsNullOrWhiteSpace(file)&&!Path.IsPathRooted(file))throw new InvalidOperationException("凭据只填写本机私有 JSON 绝对路径");return new Dictionary<string,object>{{"providerId",providerId},{"id",id.Trim()},{"credentialFile",file.Trim()},{"models",models??new string[0]}};}
        internal static Dictionary<string,object> ProviderKeyBody(string providerId,string id,string apiKey,string accountId,string[] models) {
            if(string.IsNullOrWhiteSpace(providerId)||string.IsNullOrWhiteSpace(id))throw new InvalidOperationException("请选择平台并填写账号 ID");
            var body=new Dictionary<string,object>{{"providerId",providerId},{"id",id.Trim()},{"models",models??new string[0]}};
            string key=(apiKey??"").Trim();
            if(key.Length>0) {
                if(providerId=="cloudflare"&&string.IsNullOrWhiteSpace(accountId))throw new InvalidOperationException("Cloudflare 请填写 Account ID");
                body["apiKey"]=key;
                if(providerId=="cloudflare")body["accountId"]=accountId.Trim();
            }
            return body;
        }
        internal static string ProviderState(Dictionary<string,object> p){string state=Json.Get(p,"availability");switch(state){case "retired":return "官方已退役";case "paid_only":return "当前仅付费 · 不声明免费";case "non_chat":return "非聊天服务";case "configuration_required":return "需要额外配置";case "restricted_promotion":return "限条件活动 · 请核对官方政策";case "reuse_existing":return "复用已有专用平台入口";}if(object.Equals(p.ContainsKey("missingCredential")?p["missingCredential"]:false,true)||state=="credential_required")return "待配置凭据";return "待核验（未确认可调用）";}
        internal static string ProviderSummary(Dictionary<string,object> p){var quota=ActivityData.Child(p,"quota");var policy=ActivityData.Child(quota,"policy");return string.Join(Environment.NewLine,new[]{Json.Get(p,"name"),"状态："+ProviderState(p),"协议："+Json.Get(p,"protocol","待核验"),"实时余额："+ActivityData.Number(quota,"remaining")+"（未核验不表示零）","额度说明："+Json.Get(quota,"note","以官方实时限额为准"),"公示政策（不是实时余额）："+Json.Get(policy,"note","未提供"),"政策来源："+Json.Get(policy,"source","未提供"),"凭据字段："+string.Join("、",Json.Strings(p,"credentialFields")),Json.Get(p,"note")});}
    }
    internal static class WbPoolUi {
        internal const int CardWidth=460,CardMinWidth=410,CardHeight=640,ModelHeight=130,ToolbarMinHeight=38,TotalHeight=48,CardInset=12,DetailGap=8,WideAccountWidth=900;
        internal static readonly Font CompactTotalFont=new Font("Microsoft YaHei UI",15F,FontStyle.Bold);
        internal static readonly Font TotalFont=new Font("Microsoft YaHei UI",23F,FontStyle.Bold),CreditFont=new Font("Microsoft YaHei UI",21F,FontStyle.Bold),HeadingFont=new Font(Theme.Body,FontStyle.Bold);
        internal static bool ShowInOverview(IDictionary<string,object> row){return !string.Equals(Json.Get(row,"platform"),"workbuddy",StringComparison.OrdinalIgnoreCase);}
        internal static bool Flag(IDictionary<string,object> row,string key){return row.ContainsKey(key)&&object.Equals(row[key],true);}
        internal static bool InferenceEnabled(IDictionary<string,object> row){return !row.ContainsKey("inferenceEnabled")||!object.Equals(row["inferenceEnabled"],false);}
        internal static string Amount(IDictionary<string,object> row,string field){decimal n;return decimal.TryParse(Json.Get(row,field),out n)?n.ToString("#,##0.###"):"待获取";}
        internal static string Credits(IDictionary<string,object> row){return Amount(row,"remaining")+" / "+Amount(row,"total");}
        internal static string Uid(IDictionary<string,object> row){return Json.Get(row,"uid",Json.Get(NvidiaPresentation.Object(row,"identity"),"uid","未返回"));}
        internal static string Time(IDictionary<string,object> row,string key){string value=Json.Get(row,key);DateTimeOffset parsed;if(string.IsNullOrWhiteSpace(value))return "未返回";if(DateTimeOffset.TryParse(value,out parsed))return parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz");long millis;if(long.TryParse(value,out millis)&&millis>1000000000){try{return new DateTimeOffset(1970,1,1,0,0,0,TimeSpan.Zero).AddSeconds(millis>100000000000?millis/1000d:millis).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz");}catch{}}return value;}
        internal static string Error(IDictionary<string,object> row,string key){var error=NvidiaPresentation.Object(row,key);return error.Count>0?Json.Get(error,"message",Json.Get(error,"code","未返回原因")):Json.Get(row,key,"");}
        internal static bool IsBanned(IDictionary<string,object> row){return Json.Get(NvidiaPresentation.Object(row,"ban"),"status")=="banned"||Json.Get(row,"credentialStatus")=="banned";}
        // 只有落在登录/账号本身（401/403、账号缺失或停用、凭据过期）才算“登录不上去”；
        // 网络抖动（provider_timeout 等传输失败）不代表账号死了，保持常色，避免整片误红。
        internal static bool LoginFailed(IDictionary<string,object> row){
            var error=NvidiaPresentation.Object(row,"error");
            if(object.Equals(error.ContainsKey("authRejected")?error["authRejected"]:null,true))return true;
            switch(Json.Get(error,"code")){case "account_disabled":case "account_not_found":case "auth_rejected":case "expired":case "rejected":case "login_required":case "missing":case "invalid_grant":case "wb_refresh_login_required":return true;}
            int status;if(!int.TryParse(Json.Get(error,"httpStatus",Json.Get(error,"status")),out status))return false;
            return status==401||status==403;
        }
        internal static Color StateColor(IDictionary<string,object> row){
            string credential=Json.Get(row,"credentialStatus",Json.Get(NvidiaPresentation.Object(row,"credential"),"status")),usage=Json.Get(row,"usageStatus"),ban=Json.Get(NvidiaPresentation.Object(row,"ban"),"status");
            if(IsBanned(row)||ban=="auth_rejected")return Theme.Danger;
            switch(credential){case "banned":case "auth_rejected":case "expired":case "rejected":case "login_required":case "missing":return Theme.Danger;}
            if((credential=="check_failed"||usage=="error")&&LoginFailed(row))return Theme.Danger;
            return Theme.Accent;
        }
        internal static string State(IDictionary<string,object> row){
            string credential=Json.Get(row,"credentialStatus",Json.Get(NvidiaPresentation.Object(row,"credential"),"status")),usage=Json.Get(row,"usageStatus"),ban=Json.Get(NvidiaPresentation.Object(row,"ban"),"status");
            if(IsBanned(row))return "账号已封禁";
            if(ban=="auth_rejected"||credential=="auth_rejected")return "登录被拒绝 · 尚未判定封禁";
            if(credential=="expired"||credential=="rejected"||credential=="login_required")return "登录待更新";
            if(credential=="check_failed"||usage=="error")return "登录或余额核验失败 · 可查看明细";
            if(!Json.Enabled(row))return "已停用 · 资料保留";
            if(!InferenceEnabled(row))return "积分调用已停用 · 签到与任务不变";
            if(usage=="exhausted"||Json.Get(row,"remaining")=="0")return "积分已用完 · 自动接力下一账号";
            return Flag(row,"current")?"当前账号":"常驻账号";
        }
        internal static string CredentialState(IDictionary<string,object> row){string s=Json.Get(row,"credentialStatus",Json.Get(NvidiaPresentation.Object(row,"credential"),"status","not_checked"));switch(s){case "authenticated":return "已核验登录";case "banned":return "已封禁";case "auth_rejected":return "认证被拒绝（非封禁结论）";case "expired":case "rejected":case "login_required":return "需要重新登录";case "not_checked":return "尚未核验";case "check_failed":return "核验失败";default:return s;}}
        internal static string DailyBadge(IDictionary<string,object> row){return DailyBadge(row,DateTimeOffset.Now);}
        internal static string DailyBadge(IDictionary<string,object> row,DateTimeOffset now){
            var daily=NvidiaPresentation.Object(row,"dailyCheckin");string status=Json.Get(daily,"status","unknown");DateTimeOffset checkedAt;object flag;
            if(new[]{"expired","rejected","auth_rejected","login_required","missing","check_failed","banned"}.Contains(Json.Get(row,"credentialStatus",Json.Get(NvidiaPresentation.Object(row,"credential"),"status"))))return "今日签到待核验";
            if(Flag(row,"stale")||row.ContainsKey("error")&&row["error"]!=null||Flag(daily,"stale")||Flag(NvidiaPresentation.Object(row,"balance"),"stale")||NvidiaPresentation.Object(row,"balance").ContainsKey("error")&&NvidiaPresentation.Object(row,"balance")["error"]!=null||daily.ContainsKey("error")&&daily["error"]!=null||object.Equals(daily.ContainsKey("known")?daily["known"]:null,false))return "今日签到待核验";
            if(!DateTimeOffset.TryParse(Json.Get(daily,"checkedAt"),out checkedAt)||checkedAt.ToOffset(now.Offset).Date!=now.Date||checkedAt>now.AddMinutes(5))return "今日签到待核验";
            if(!daily.TryGetValue("todayCheckedIn",out flag)||!(flag is bool))return "今日签到待核验";
            if((bool)flag&&(status=="claimed"||status=="already_claimed"))return "今日已签到";
            if(!(bool)flag&&status=="not_claimed"&&!object.Equals(daily.ContainsKey("active")?daily["active"]:null,false))return "今日未签到";
            return "今日签到待核验";
        }
        private static string RefreshFailure(IDictionary<string,object> row,string key){var error=NvidiaPresentation.Object(row,key);return Json.Get(error,"code",Json.Get(error,"message",Error(row,key)));}
        private static string PendingCheckinReason(IDictionary<string,object> row){
            var daily=NvidiaPresentation.Object(row,"dailyCheckin");var balance=NvidiaPresentation.Object(row,"balance");string credential=Json.Get(row,"credentialStatus",Json.Get(NvidiaPresentation.Object(row,"credential"),"status"));
            if(new[]{"expired","rejected","auth_rejected","login_required","missing","check_failed","banned"}.Contains(credential))return "登录待更新（"+credential+"）";
            string reason=RefreshFailure(daily,"error");if(reason.Length>0)return "签到查询失败（"+reason+"）";
            reason=RefreshFailure(balance,"error");if(reason.Length==0)reason=RefreshFailure(row,"error");if(reason.Length>0)return "余额或登录核验失败（"+reason+"）";
            if(Flag(row,"stale")||Flag(balance,"stale")||Flag(daily,"stale"))return "上次成功缓存，待重新核验";
            DateTimeOffset checkedAt;if(!DateTimeOffset.TryParse(Json.Get(daily,"checkedAt"),out checkedAt))return "缺少签到核验时间";
            if(checkedAt.ToOffset(DateTimeOffset.Now.Offset).Date!=DateTimeOffset.Now.Date)return "签到核验不在今日";
            if(object.Equals(daily.ContainsKey("active")?daily["active"]:null,false))return "签到活动未开放";
            return "服务端未确认签到状态（"+Json.Get(daily,"status","unknown")+"）";
        }
        internal static string BalanceRefreshStatus(Dictionary<string,object> balances,Dictionary<string,object> summary){var rows=Json.Rows(summary??new Dictionary<string,object>(),"accounts").ToArray();return "余额"+Json.Rows(balances,"accounts").Count()+" · WB 已"+rows.Count(r=>DailyBadge(r)=="今日已签到")+"/未"+rows.Count(r=>DailyBadge(r)=="今日未签到")+"/待核"+rows.Count(r=>DailyBadge(r)=="今日签到待核验");}
        internal static string BalanceRefreshReceipt(Dictionary<string,object> balances,Dictionary<string,object> summary,out bool attention){
            var balanceRows=Json.Rows(balances,"accounts").ToArray();var balanceErrors=balanceRows.Where(r=>RefreshFailure(r,"error").Length>0||Flag(r,"stale")).ToArray();
            string receipt="余额返回 "+balanceRows.Length+" 项"+(balanceErrors.Length>0?"，失败 "+balanceErrors.Length:"");
            if(summary==null){attention=true;return receipt+" · WB今日签到明细待同步";}
            var rows=Json.Rows(summary,"accounts").ToArray();var pending=rows.Where(r=>DailyBadge(r)=="今日签到待核验").ToArray();int signed=rows.Count(r=>DailyBadge(r)=="今日已签到"),unsigned=rows.Count(r=>DailyBadge(r)=="今日未签到");
            receipt+=" · WB今日签到：已签 "+signed+" · 未签 "+unsigned+" · 待核验 "+pending.Length;
            if(pending.Length>0)receipt+="；原因："+string.Join("；",pending.Select(PendingCheckinReason).GroupBy(x=>x).Select(g=>g.Key+" ×"+g.Count()));
            if(balanceErrors.Length>0)receipt+="；余额失败原因："+string.Join("；",balanceErrors.Select(r=>RefreshFailure(r,"error").Length>0?RefreshFailure(r,"error"):"缓存待核验").Distinct());
            attention=pending.Length>0||balanceErrors.Length>0;return receipt;
        }
        internal static string Daily(IDictionary<string,object> row){string badge=DailyBadge(row);var daily=NvidiaPresentation.Object(row,"dailyCheckin");return badge=="今日已签到"?badge+" · 今日到账 "+Amount(daily,"todayCredit")+" 积分":badge;}
        internal static string TaskState(IDictionary<string,object> task){if(Flag(task,"claimed"))return "已领取";if(Flag(task,"locked"))return "未解锁";if(Flag(task,"claimable")||Flag(task,"qualified"))return "已达标 · 待领取";if(Flag(task,"accepted"))return "已接受 · 进行中";string state=Json.Get(task,"status",Json.Get(task,"acceptStatus","not_accepted"));switch(state){case "claimed":return "已领取";case "not_accepted":return "尚未接受";case "accepted":case "in_progress":case "progress":return "进行中";case "completed":return "已完成 · 领取待核验";case "locked":return "未解锁";default:return state;}}
        internal static string TaskSummary(IDictionary<string,object> row){var block=NvidiaPresentation.Object(row,"tasks");var items=Json.Rows(block,"items").ToArray();if(items.Length==0)return "任务列表待查询 · 不把未返回状态算完成";return items.Length+" 项任务 · 已领取 "+items.Count(t=>Flag(t,"claimed"))+" · 达标待领 "+items.Count(t=>!Flag(t,"claimed")&&(Flag(t,"claimable")||Flag(t,"qualified")))+" · 进行中 "+items.Count(t=>!Flag(t,"claimed")&&!Flag(t,"locked")&&Flag(t,"accepted"))+" · 未接受 "+items.Count(t=>!Flag(t,"claimed")&&!Flag(t,"locked")&&!Flag(t,"accepted"));}
        internal static string Progress(IDictionary<string,object> task){return Json.Get(task,"current",Json.Get(task,"progress","?"))+" / "+Json.Get(task,"target","?");}
        internal static string Reward(IDictionary<string,object> task){string reward=Json.Get(task,"reward");if(!string.IsNullOrWhiteSpace(reward))return reward;return "+"+Amount(task,"rewardCredit")+" 积分 · "+Amount(task,"rewardEnergy")+" 能量"+(Flag(task,"rewardBuddy")?" · Buddy":"");}
        internal static string Receipt(IDictionary<string,object> receipt){if(receipt.Count==0)return "尚无操作回执";string result=Json.Get(receipt,"status","待确认"),error=Error(receipt,"error");return result+" · "+(Flag(receipt,"serverConfirmed")?"服务端已确认":"服务端尚未确认")+(string.IsNullOrWhiteSpace(error)?"":" · "+error)+" · "+Time(receipt,"checkedAt");}
        internal static Label Line(string text,bool heading=false){return new Label {Text=text,AutoSize=true,Font=heading?HeadingFont:Theme.Body,ForeColor=heading?Theme.Ink:Theme.Muted,Margin=new Padding(0,heading?14:0,0,DetailGap),AccessibleName=text};}
        internal static TextBox Identity(string title,string value){return new TextBox {Text=title+"  "+value,ReadOnly=true,Multiline=true,WordWrap=true,BorderStyle=BorderStyle.None,BackColor=Theme.Surface,ForeColor=Theme.Ink,Font=Theme.Body,Margin=new Padding(0,0,0,6),Height=24,AccessibleName=title};}
        internal static FlowLayoutPanel Stack(){return new FlowLayoutPanel {FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,Margin=Padding.Empty,Padding=Padding.Empty};}
        internal static void FitStack(FlowLayoutPanel stack,int width){width=Math.Max(160,width);stack.Width=width;foreach(Control c in stack.Controls){var label=c as Label;if(label!=null){label.MaximumSize=new Size(width,0);label.MinimumSize=new Size(0,0);}else if(c is TextBox){c.Width=width;c.Height=Math.Max(24,TextRenderer.MeasureText(c.Text,c.Font,new Size(width,0),TextFormatFlags.WordBreak|TextFormatFlags.TextBoxControl).Height+4);}else {c.Width=width;var flow=c as FlowLayoutPanel;if(flow!=null){flow.MaximumSize=new Size(width,0);flow.MinimumSize=new Size(width,0);}}}}
    }
    internal sealed class WbSectionPager : UserControl {
        private readonly Label heading=new Label {Dock=DockStyle.Top,Height=24,Font=WbPoolUi.HeadingFont,ForeColor=Theme.Ink};
        private readonly TextBox body=new TextBox {Multiline=true,Dock=DockStyle.Fill,ReadOnly=true,BorderStyle=BorderStyle.None,BackColor=Theme.Surface,ForeColor=Theme.Muted,Font=Theme.Body,WordWrap=false,ScrollBars=ScrollBars.None,TabStop=true};
        private readonly Panel footer=new Panel {Dock=DockStyle.Bottom,Height=30};
        private readonly Button before=Theme.Button("上一页"),after=Theme.Button("下一页");private readonly Label counter=new Label {TextAlign=ContentAlignment.MiddleCenter,ForeColor=Theme.Muted};
        private readonly List<string> pages=new List<string>();private readonly string fullText;private int pageIndex,requestedPage=-1;private bool fitting;
        internal string FullText {get{return fullText;}}internal int PageCount {get{return pages.Count;}}internal int PageIndex {get{return pageIndex;}}
        internal WbSectionPager(string title,string text){AccessibleName=title;BackColor=Theme.Surface;Padding=new Padding(10,4,10,4);fullText=text??"";heading.Text=title;body.AccessibleName=title+" · 当前资料页，可选中复制";Controls.Add(body);Controls.Add(footer);Controls.Add(heading);footer.Controls.Add(before);footer.Controls.Add(after);footer.Controls.Add(counter);before.MinimumSize=after.MinimumSize=new Size(66,28);before.Size=after.Size=new Size(66,28);before.AutoSize=after.AutoSize=false;before.Margin=after.Margin=Padding.Empty;before.Click+=(s,e)=>Navigate(pageIndex-1);after.Click+=(s,e)=>Navigate(pageIndex+1);SizeChanged+=(s,e)=>Paginate();body.SizeChanged+=(s,e)=>Paginate();HandleCreated+=(s,e)=>Paginate();}
        internal void Navigate(int index){if(pages.Count==0){requestedPage=Math.Max(0,index);return;}pageIndex=Math.Max(0,Math.Min(index,pages.Count-1));PresentPage();}
        private void Paginate(){if(fitting||body.ClientSize.Width<80||body.ClientSize.Height<body.Font.Height+3)return;fitting=true;try{int width=Math.Max(60,body.ClientSize.Width-18);int lineHeight=Math.Max(Font.Height+4,22);int capacity=Math.Max(1,(body.ClientSize.Height-12)/lineHeight);var lines=new List<string>();foreach(string raw in fullText.Replace("\r","").Split('\n')){if(raw.Length==0){lines.Add("");continue;}string current="";var elements=System.Globalization.StringInfo.GetTextElementEnumerator(raw);while(elements.MoveNext()){string unit=elements.GetTextElement();string next=current+unit;int measured=TextRenderer.MeasureText(next,body.Font,new Size(int.MaxValue,0),TextFormatFlags.SingleLine|TextFormatFlags.NoPadding|TextFormatFlags.NoPrefix).Width;if(measured>width&&current.Length>0){lines.Add(current);current=unit;}else current=next;}lines.Add(current);}pages.Clear();for(int i=0;i<lines.Count;i+=capacity)pages.Add(string.Join(Environment.NewLine,lines.Skip(i).Take(capacity)));if(pages.Count==0)pages.Add("尚无资料");pageIndex=Math.Max(0,Math.Min(requestedPage>=0?requestedPage:pageIndex,pages.Count-1));requestedPage=-1;int buttonWidth=66;before.SetBounds(0,0,buttonWidth,28);after.SetBounds(Math.Max(buttonWidth+4,footer.ClientSize.Width-buttonWidth),0,buttonWidth,28);counter.SetBounds(buttonWidth+2,0,Math.Max(0,footer.ClientSize.Width-buttonWidth*2-4),28);PresentPage();}finally{fitting=false;}}
        private void PresentPage(){body.Text=pages.Count==0?"":pages[pageIndex];body.Select(0,0);counter.Text="资料 "+(pages.Count==0?0:pageIndex+1)+" / "+pages.Count;before.Enabled=pageIndex>0;after.Enabled=pageIndex+1<pages.Count;}
        internal bool VisibleTextFits(){if(!body.Visible||!body.IsHandleCreated||body.TextLength==0)return true;int width=body.ClientSize.Width-6,height=body.ClientSize.Height-3;for(int i=0;i<body.TextLength;i++){char c=body.Text[i];if(c=='\r'||c=='\n')continue;Point p=body.GetPositionFromCharIndex(i);int glyph=TextRenderer.MeasureText(c.ToString(),body.Font,new Size(int.MaxValue,0),TextFormatFlags.NoPadding|TextFormatFlags.SingleLine).Width;if(p.X<0||p.Y<0||p.X+glyph>width||p.Y+body.Font.Height>height)return false;}return true;}
    }
    // A bounded metadata line keeps the new daily badge readable even in the minimum window.
    // Only the old descriptive prefix may ellipsize; the full line remains selectable via details and available to accessibility/tooltips.
    internal sealed class WbStatusLabel : Label {
        internal WbStatusLabel(){Font=Theme.Body;AutoSize=false;Margin=new Padding(0,0,0,WbPoolUi.DetailGap);}
        internal int BadgeWidth {get{int index=Text.LastIndexOf(" · 今日",StringComparison.Ordinal);return index<0?0:TextRenderer.MeasureText(Text.Substring(index),Font,new Size(int.MaxValue,0),TextFormatFlags.NoPadding|TextFormatFlags.SingleLine|TextFormatFlags.NoPrefix).Width;}}
        protected override void OnPaint(PaintEventArgs e){
            var flags=TextFormatFlags.SingleLine|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPrefix|TextFormatFlags.NoPadding;int index=Text.LastIndexOf(" · 今日",StringComparison.Ordinal);
            if(index<0||TextRenderer.MeasureText(Text,Font,new Size(int.MaxValue,0),flags).Width<=ClientSize.Width){TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,ForeColor,flags);return;}
            string prefix=Text.Substring(0,index),badge=Text.Substring(index);int badgeWidth=Math.Min(ClientSize.Width,BadgeWidth);int prefixWidth=Math.Max(0,ClientSize.Width-badgeWidth);
            if(prefixWidth>0)TextRenderer.DrawText(e.Graphics,prefix,Font,new Rectangle(0,0,prefixWidth,ClientSize.Height),ForeColor,flags|TextFormatFlags.EndEllipsis);
            TextRenderer.DrawText(e.Graphics,badge,Font,new Rectangle(prefixWidth,0,badgeWidth,ClientSize.Height),ForeColor,flags);
        }
    }
    internal sealed class WbAccountCard : Panel {
        private readonly Panel header=new Panel(),content=new Panel();private readonly FlowLayoutPanel actions=new FlowLayoutPanel {WrapContents=true,AutoSize=false};
        private readonly Label name=WbPoolUi.Line("",true),state=new WbStatusLabel(),credit=WbPoolUi.Line("");
        private readonly WbSectionPager[] sections;private readonly TabControl tabs=new TabControl {Dock=DockStyle.Fill,Font=Theme.Body};private readonly TableLayoutPanel columns=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=3,RowCount=1};private bool fitting,compact,modelMode;private Control modelView;private readonly ContextMenuStrip accountMenu=new ContextMenuStrip();private readonly ToolTip actionTips=new ToolTip();private readonly List<Button> menuButtons=new List<Button>();private Button more;
        internal string AccountId {get;private set;}internal bool Compact {get{return compact;}}
        internal WbAccountCard(Dictionary<string,object> row){Dock=DockStyle.Fill;BackColor=Theme.Surface;Padding=new Padding(12);Margin=Padding.Empty;AccessibleName=Json.Get(row,"label","WorkBuddy 账号");AccountId=Json.Get(row,"accountId",Json.Get(row,"id"));
            var identity=NvidiaPresentation.Object(row,"identity");var profile=NvidiaPresentation.Object(row,"profile");var credential=NvidiaPresentation.Object(row,"credential");var ban=NvidiaPresentation.Object(row,"ban");var balance=NvidiaPresentation.Object(row,"balance");var tasks=NvidiaPresentation.Object(row,"tasks");var packages=Json.Rows(balance,"packages").ToArray();
            string label=Json.Get(row,"label","WorkBuddy 账号");name.Text=label.Length>28?label.Substring(0,22)+"…（完整见身份页）":label;name.Font=new Font(Theme.Body.FontFamily,12F,FontStyle.Bold);name.AutoSize=false;name.AutoEllipsis=true;name.AccessibleDescription=label;actionTips.SetToolTip(name,label);name.ForeColor=Theme.Ink;state.Text=WbPoolUi.State(row)+" · "+(Json.Get(row,"edition","cn")=="cn"?"国内版 CN":"国际版 Global")+" · "+(Json.Enabled(row)?"启用":"停用")+" · "+WbPoolUi.DailyBadge(row);state.AutoSize=false;state.AutoEllipsis=false;state.AccessibleDescription=state.Text;actionTips.SetToolTip(state,state.Text);state.ForeColor=WbPoolUi.StateColor(row);credit.Text=WbPoolUi.Credits(row);credit.Font=WbPoolUi.CreditFont;credit.AutoSize=false;credit.TextAlign=ContentAlignment.MiddleRight;credit.ForeColor=Theme.Ink;credit.AccessibleName="账号积分剩余 / 总额";header.Controls.Add(name);header.Controls.Add(state);header.Controls.Add(credit);
            string identityText="账号 ID："+AccountId+"\nUID："+WbPoolUi.Uid(row)+"\n用户 ID："+Json.Get(identity,"userId","未返回")+"\n昵称："+Json.Get(profile,"nickname",Json.Get(row,"nickname","未返回"))+"\n用户名："+Json.Get(identity,"username",Json.Get(profile,"username","未返回"))+"\n邮箱："+Json.Get(row,"email",Json.Get(identity,"email","未返回"))+"\n区域："+Json.Get(row,"region",Json.Get(identity,"domain","未返回"))+"\n显示名称："+Json.Get(row,"label","未返回")+"\n备注："+Json.Get(row,"notes","未填写")+"\n版本："+Json.Get(row,"edition","cn")+" · "+(Json.Enabled(row)?"已启用":"已停用")+" · "+(WbPoolUi.Flag(row,"current")?"当前使用账号":"非当前账号");
            identityText+="\n积分与模型调用："+(WbPoolUi.InferenceEnabled(row)?"已启用":"已停用，模型切换与接力跳过此号")+"\n自动签到与自动任务：保持账号池原设置，不受积分调用开关影响";string reason=Json.Get(ban,"reason",WbPoolUi.Error(row,"error"));string loginText=WbPoolUi.CredentialState(row)+"\n登录核验："+WbPoolUi.Time(credential,"checkedAt")+"\nAccess 到期："+WbPoolUi.Time(credential,"accessExpiresAt")+"\nRefresh 到期："+WbPoolUi.Time(credential,"refreshExpiresAt")+"\n封禁状态："+(WbPoolUi.IsBanned(row)?"账号已封禁":Json.Get(ban,"status")=="auth_rejected"?"认证被拒绝，尚未判定封禁":"未确认封禁")+"\n状态原因："+(string.IsNullOrWhiteSpace(reason)?"未返回":reason)+"\n来源："+Json.Get(ban,"source","未返回")+"\nHTTP："+Json.Get(ban,"httpStatus","未返回")+" · 官方代码："+Json.Get(ban,"upstreamCode","未返回")+"\n状态更新时间："+WbPoolUi.Time(ban,"checkedAt");
            var balanceText=new StringBuilder();balanceText.AppendLine("积分剩余 / 总额："+WbPoolUi.Credits(row));balanceText.AppendLine("已消耗："+WbPoolUi.Amount(balance,"consumed")+" · 积分包 "+packages.Length+" 个");balanceText.AppendLine(WbPoolUi.Daily(row));balanceText.AppendLine(WbPoolUi.TaskSummary(row));balanceText.AppendLine("任务查询："+WbPoolUi.Time(tasks,"checkedAt"));string taskError=WbPoolUi.Error(tasks,"error");if(!string.IsNullOrWhiteSpace(taskError))balanceText.AppendLine("任务错误："+taskError+"；上次成功任务保留");balanceText.AppendLine("余额核验："+WbPoolUi.Time(balance.Count>0?balance:row,"checkedAt")+(WbPoolUi.Flag(balance,"stale")||WbPoolUi.Flag(row,"stale")?" · 上次成功数据":""));balanceText.AppendLine("全部积分包（资料分页，不省略包）");if(packages.Length==0)balanceText.AppendLine("官方尚未返回积分包明细；不按零处理。");foreach(var package in packages){balanceText.AppendLine(Json.Get(package,"name",Json.Get(package,"id","积分包"))+"  "+WbPoolUi.Amount(package,package.ContainsKey("remaining")?"remaining":"balance")+" / "+WbPoolUi.Amount(package,package.ContainsKey("total")?"total":"size"));balanceText.AppendLine("包 ID："+Json.Get(package,"id","未返回")+" · 到期："+WbPoolUi.Time(package,"expiresAt"));}
            sections=new[]{new WbSectionPager("身份资料 · 完整 ID / UID",identityText),new WbSectionPager("登录有效期与封禁依据",loginText),new WbSectionPager("积分包、签到与任务",balanceText.ToString().TrimEnd())};
            for(int i=0;i<3;i++)columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100f/3));columns.RowStyles.Add(new RowStyle(SizeType.Percent,100));for(int i=0;i<3;i++)tabs.TabPages.Add(new TabPage(i==0?"身份资料":i==1?"登录与封禁":"积分与任务"){BackColor=Theme.Surface,Padding=Padding.Empty});Controls.Add(content);Controls.Add(header);Controls.Add(actions);SizeChanged+=(s,e)=>Fit();Paint+=(s,e)=>{using(var pen=new Pen(UiMetrics.Line))e.Graphics.DrawRectangle(pen,0,0,Width-1,Height-1);};Fit();
        }
        internal void AddAction(Button b){int actionWidth=92;b.AutoSize=false;b.MinimumSize=new Size(actionWidth,Theme.ButtonHeight);b.Size=new Size(actionWidth,Theme.ButtonHeight);b.Margin=new Padding(0,0,4,4);if(new[]{"切换此号","积分任务","删除账号","停用积分调用","启用积分调用"}.Contains(b.Text)){actions.Controls.Add(b);if(more!=null)actions.Controls.SetChildIndex(more,actions.Controls.Count-1);}else{if(more==null){more=Theme.Button("更多操作");more.AutoSize=false;more.MinimumSize=new Size(92,Theme.ButtonHeight);more.Size=new Size(92,Theme.ButtonHeight);more.Margin=new Padding(0,0,4,4);more.Click+=(s,e)=>accountMenu.Show(more,new Point(0,more.Height));actions.Controls.Add(more);}var item=new ToolStripMenuItem(b.Text);item.Click+=(s,e)=>b.PerformClick();accountMenu.Items.Add(item);menuButtons.Add(b);}if(!string.IsNullOrEmpty(b.AccessibleDescription))actionTips.SetToolTip(b,b.AccessibleDescription);Fit();}
        internal string[] SecondaryActions {get{return accountMenu.Items.Cast<ToolStripItem>().Select(i=>i.Text).ToArray();}}
        protected override void Dispose(bool disposing){if(disposing){foreach(var b in menuButtons)b.Dispose();accountMenu.Dispose();actionTips.Dispose();}base.Dispose(disposing);}
        private void Fit(){if(fitting||ClientSize.Width<80)return;fitting=true;try{int inset=12,width=ClientSize.Width-inset*2;bool nextCompact=width<WbPoolUi.WideAccountWidth;int used=0,rows=1;foreach(Control action in actions.Controls){int required=action.Width+action.Margin.Horizontal;if(used>0&&used+required>width){rows++;used=0;}used+=required;}int actionHeight=rows*40;actions.SetBounds(inset,ClientSize.Height-inset-actionHeight,width,actionHeight);Size amountSize=TextRenderer.MeasureText(credit.Text,credit.Font,new Size(int.MaxValue,0),TextFormatFlags.SingleLine|TextFormatFlags.NoPrefix);bool stackedCredit=amountSize.Width+8>width/2;int creditHeight=Math.Max(42,TextRenderer.MeasureText(credit.Text,credit.Font,new Size(width,0),TextFormatFlags.WordBreak|TextFormatFlags.TextBoxControl|TextFormatFlags.NoPrefix).Height+4);int stackedHeading=52;bool shortStacked=stackedCredit&&ClientSize.Height-inset*2-actionHeight-(52+creditHeight)<136;if(shortStacked)stackedHeading=26;int headerHeight=stackedCredit?stackedHeading+creditHeight:60;header.SetBounds(inset,inset,width,headerHeight);if(stackedCredit){if(shortStacked){int labelWidth=width*55/100;name.SetBounds(0,0,labelWidth-6,24);state.SetBounds(labelWidth,0,width-labelWidth,24);}else{name.SetBounds(0,0,width,24);state.SetBounds(0,26,width,24);}credit.SetBounds(0,stackedHeading-2,width,creditHeight);credit.TextAlign=ContentAlignment.MiddleLeft;}else{int creditWidth=Math.Min(width/2,Math.Max(amountSize.Width+8,240));name.SetBounds(0,0,width-creditWidth-10,26);state.SetBounds(0,28,width-creditWidth-10,28);credit.SetBounds(width-creditWidth,0,creditWidth,Math.Max(42,amountSize.Height+4));credit.TextAlign=ContentAlignment.MiddleRight;}content.SetBounds(inset,inset+headerHeight,width,Math.Max(80,actions.Top-inset-header.Bottom));
                if(content.Controls.Count==0||compact!=nextCompact){foreach(var section in sections)if(section.Parent!=null)section.Parent.Controls.Remove(section);content.Controls.Clear();compact=nextCompact;if(compact){for(int i=0;i<3;i++){sections[i].Dock=DockStyle.Fill;tabs.TabPages[i].Controls.Add(sections[i]);}tabs.Visible=true;content.Controls.Add(tabs);}else{for(int i=0;i<3;i++){sections[i].Dock=DockStyle.Fill;sections[i].Margin=new Padding(i==0?0:8,0,0,0);columns.Controls.Add(sections[i],i,0);}columns.Visible=true;content.Controls.Add(columns);}}content.PerformLayout();if(modelMode&&modelView!=null)ShowModels(modelView,true);}finally{fitting=false;}}
        internal void SelectSection(int index){if(compact)tabs.SelectedIndex=Math.Max(0,Math.Min(2,index));}
        internal void ShowModels(Control model,bool show){modelMode=show;modelView=model;if(show){foreach(Control child in content.Controls)if(child!=model)child.Visible=false;if(model.Parent!=content){if(model.Parent!=null)model.Parent.Controls.Remove(model);model.Dock=DockStyle.Fill;content.Controls.Add(model);}model.Visible=true;model.BringToFront();}else{if(model.Parent==content)content.Controls.Remove(model);model.Visible=false;foreach(Control child in content.Controls)child.Visible=true;}}
        internal int SelectedSection {get{return compact?tabs.SelectedIndex:0;}}
        internal int[] CaptureBrowseState(){return new[]{SelectedSection,sections[0].PageIndex,sections[1].PageIndex,sections[2].PageIndex};}
        internal void RestoreBrowseState(int[] value){if(value==null||value.Length!=4)return;SelectSection(value[0]);content.PerformLayout();for(int i=0;i<3;i++)sections[i].Navigate(value[i+1]);}
        internal WbSectionPager[] Sections {get{return sections;}}
    }
    internal sealed class WbAccountDetailsForm : ProductForm {
        internal WbAccountDetailsForm(Dictionary<string,object> row){Text="WB 账号完整详情 · "+Json.Get(row,"label",Json.Get(row,"accountId"));Size=new Size(1040,820);MinimumSize=new Size(720,540);StartPosition=FormStartPosition.CenterParent;Font=Theme.Body;BackColor=Theme.Background;Padding=new Padding(20);
            var tabs=new TabControl {Dock=DockStyle.Fill,Font=Theme.Body};Controls.Add(tabs);var close=Theme.Button("关闭详情");close.Dock=DockStyle.Bottom;close.Click+=(s,e)=>Close();Controls.Add(close);
            var identity=NvidiaPresentation.Object(row,"identity");var credential=NvidiaPresentation.Object(row,"credential");var ban=NvidiaPresentation.Object(row,"ban");var balance=NvidiaPresentation.Object(row,"balance");var tasks=NvidiaPresentation.Object(row,"tasks");
            var info=DetailPage(tabs,"账号资料与登录状态");Add(info,"积分剩余 / 总额",WbPoolUi.Credits(row));Add(info,"显示名称",Json.Get(row,"label","未返回"));Add(info,"备注",Json.Get(row,"notes","未填写"));Add(info,"账号 ID",Json.Get(row,"accountId",Json.Get(row,"id","未返回")));Add(info,"UID",WbPoolUi.Uid(row));
            foreach(string key in new[]{"userId","username","nickname","email","domain","source","readError"})Add(info,key,Json.Get(identity,key,"未返回"));Add(info,"版本 / 区域",Json.Get(row,"edition","cn")+" / "+Json.Get(row,"region","未返回"));Add(info,"启用 / 当前",(Json.Enabled(row)?"已启用":"已停用")+" / "+(WbPoolUi.Flag(row,"current")?"当前账号":"非当前账号"));Add(info,"登录状态",WbPoolUi.CredentialState(row));Add(info,"Access 有效期",WbPoolUi.Time(credential,"accessExpiresAt"));Add(info,"Refresh 有效期",WbPoolUi.Time(credential,"refreshExpiresAt"));Add(info,"登录核验时间",WbPoolUi.Time(credential,"checkedAt"));Add(info,"封禁结论",WbPoolUi.IsBanned(row)?"账号已封禁":Json.Get(ban,"status","unknown")=="auth_rejected"?"认证被拒绝，尚未判定封禁":"未确认封禁");foreach(string key in new[]{"reason","source","httpStatus","upstreamCode"})Add(info,"状态 "+key,Json.Get(ban,key,"未返回"));Add(info,"状态核验时间",WbPoolUi.Time(ban,"checkedAt"));
            var credits=DetailPage(tabs,"全部积分包");Add(credits,"积分剩余 / 总额",WbPoolUi.Credits(row));Add(credits,"累计消耗",WbPoolUi.Amount(balance,"consumed"));Add(credits,"本次核验",WbPoolUi.Time(balance,"checkedAt"));Add(credits,"上次成功",WbPoolUi.Time(balance,"lastSuccessAt"));Add(credits,"上次失败",WbPoolUi.Time(balance,"lastFailureAt"));Add(credits,"余额错误",WbPoolUi.Error(balance,"error"));
            var packages=Json.Rows(balance,"packages").ToArray();if(packages.Length==0)Add(credits,"积分包","服务端尚未返回明细，不按零处理");foreach(var package in packages){Add(credits,Json.Get(package,"name","积分包"),WbPoolUi.Amount(package,package.ContainsKey("remaining")?"remaining":"balance")+" / "+WbPoolUi.Amount(package,package.ContainsKey("total")?"total":"size")+" · 已消耗 "+WbPoolUi.Amount(package,"consumed"));foreach(string key in new[]{"id","packageCode","subProductCode","status"})Add(credits,key,Json.Get(package,key,"未返回"));foreach(string key in new[]{"expiresAt","createdAt","refreshAt"})Add(credits,key,WbPoolUi.Time(package,key));}
            var taskPage=DetailPage(tabs,"全部任务状态");Add(taskPage,"签到",WbPoolUi.Daily(row));Add(taskPage,"任务摘要",WbPoolUi.TaskSummary(row));Add(taskPage,"最近查询",WbPoolUi.Time(tasks,"checkedAt"));Add(taskPage,"查询错误",WbPoolUi.Error(tasks,"error"));foreach(var task in Json.Rows(tasks,"items")){Add(taskPage,Json.Get(task,"title",Json.Get(task,"taskCode"))+" / "+Json.Get(task,"taskCode"),WbPoolUi.TaskState(task));Add(taskPage,"任务内容",Json.Get(task,"description","未返回说明"));Add(taskPage,"进度 / 奖励",WbPoolUi.Progress(task)+" · "+WbPoolUi.Reward(task));Add(taskPage,"执行条件",WbPoolUi.Flag(task,"automaticExecution")?"已接入真实功能执行器":"需要实际使用对应功能；支持接受和达标领取");Add(taskPage,"最近回执",WbPoolUi.Receipt(NvidiaPresentation.Object(task,"lastReceipt")));}
            var receipts=DetailPage(tabs,"操作回执");var logs=Json.Rows(tasks,"receipts").ToArray();if(logs.Length==0)Add(receipts,"回执","尚无任务操作回执");foreach(var receipt in logs.Reverse()){Add(receipts,Json.Get(receipt,"taskCode","任务")+" / "+Json.Get(receipt,"action","操作"),WbPoolUi.Receipt(receipt));Add(receipts,"领取结果","积分 "+WbPoolUi.Amount(receipt,"credit")+" · 能量 "+WbPoolUi.Amount(receipt,"energy"));}
        }
        private FlowLayoutPanel DetailPage(TabControl tabs,string title){var page=new TabPage(title){BackColor=Theme.Surface,Padding=new Padding(18)};var scroll=new Panel {Dock=DockStyle.Fill,AutoScroll=true};var flow=WbPoolUi.Stack();scroll.Controls.Add(flow);scroll.SizeChanged+=(s,e)=>{WbPoolUi.FitStack(flow,scroll.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-4);flow.PerformLayout();};page.Controls.Add(scroll);tabs.TabPages.Add(page);return flow;}
        private void Add(FlowLayoutPanel flow,string key,string value){flow.Controls.Add(WbPoolUi.Line(key,true));flow.Controls.Add(WbPoolUi.Identity(key+"：",string.IsNullOrWhiteSpace(value)?"未返回":value));}
    }
    internal sealed class WbPoolBoard : UserControl {
        [DllImport("user32.dll",CharSet=CharSet.Unicode)]private static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr wparam,string text);
        private readonly Gateway backend;private readonly Func<Task> reload;
        private readonly FlowLayoutPanel toolbar=new FlowLayoutPanel {WrapContents=true,Margin=Padding.Empty,Padding=Padding.Empty};
        private readonly Panel cards=new Panel {AutoScroll=false,BackColor=Theme.Background};
        private readonly Label totals=new Label {Font=WbPoolUi.TotalFont,ForeColor=Theme.Ink,AccessibleName="WB池积分剩余与总额",TextAlign=ContentAlignment.MiddleLeft};
        private readonly Label aggregateNote=new Label {ForeColor=Theme.Muted};private readonly Label note=new Label {ForeColor=Theme.Muted};
        private readonly DataGridView models=Theme.Grid("模型 / 版本","参与账号","接力策略");
        private readonly CheckBox autoMigrate=new CheckBox {Text="自动迁移聊天",AutoSize=true,Margin=new Padding(2,7,4,0)};private readonly CheckBox autoTasks=new CheckBox {Text="自动任务（独立于调用）",AutoSize=true,Margin=new Padding(0,7,4,0)};
        private readonly Panel navigation=new Panel();private readonly TextBox search=new TextBox {AccessibleName="按账号名称、ID、UID搜索"};private readonly ComboBox accountPicker=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,AccessibleName="快速跳转账号",DropDownWidth=650};
        private readonly Label pageCount=new Label {TextAlign=ContentAlignment.MiddleCenter,ForeColor=Theme.Ink};private readonly Button first=Theme.Button("首页"),previous=Theme.Button("上一号"),next=Theme.Button("下一号"),last=Theme.Button("末页"),modelToggle=Theme.Button("模型");
        private readonly ToolStripMenuItem autoMigrateMenu=new ToolStripMenuItem("自动迁移聊天") {CheckOnClick=true},autoTasksMenu=new ToolStripMenuItem("自动任务（独立于积分调用）") {CheckOnClick=true};private readonly ContextMenuStrip globalMenu=new ContextMenuStrip();private readonly List<Dictionary<string,object>> filtered=new List<Dictionary<string,object>>();private readonly SemaphoreSlim loadGate=new SemaphoreSlim(1,1);private Dictionary<string,object>[] accounts=new Dictionary<string,object>[0];private int index;private bool binding,operating,operationCancelled,modelsExpanded,arranging;
        private const string ProcessingNote="正在处理；当前浏览账号与已有数据保留…";
        private bool CanPresent {get{return !IsDisposed&&!Disposing;}}
        private void SetNote(string text,Color color){if(!CanPresent)return;note.ForeColor=color;note.Text=text;LayoutBoard();}
        private void CancelOperation(){operationCancelled=true;}
        internal Dictionary<string,object> LastSummary;internal int PageIndex {get{return index;}}internal int PageCount {get{return filtered.Count;}}internal string CurrentAccountId {get{return filtered.Count==0?null:Id(filtered[index]);}}internal int TotalAccountCount {get{return accounts.Length;}}
        internal WbPoolBoard(Gateway backend,Func<Task> reload){this.backend=backend;this.reload=reload;BackColor=Theme.Background;Padding=new Padding(12);Font=Theme.Body;Controls.Add(cards);Controls.Add(models);Controls.Add(note);Controls.Add(totals);Controls.Add(aggregateNote);Controls.Add(toolbar);Controls.Add(navigation);models.Visible=false;models.AccessibleName="WB 模型列表，每型号仅一行";
            var operations=Theme.Button("账号池操作");operations.AutoSize=false;operations.MinimumSize=new Size(105,Theme.ButtonHeight);operations.Size=new Size(105,Theme.ButtonHeight);operations.Margin=new Padding(0,0,4,0);operations.Click+=(s,e)=>globalMenu.Show(operations,new Point(0,operations.Height));toolbar.Controls.Add(operations);
            AddGlobal("添加登录",Login);AddGlobal("保存客户端当前账号",CaptureSession);AddGlobal("刷新全部积分",()=>Task.FromResult(0),true);AddGlobal("一键合并聊天",async()=>{if(MessageBox.Show(FindForm(),"将所有已保存账号的本机会话以新副本合并到当前账号，保留来源记录；云同步由官方客户端下次启动确认。请先关闭 WorkBuddy 客户端。继续？","合并聊天",MessageBoxButtons.YesNo)!=DialogResult.Yes){CancelOperation();return;}ShowResult(await backend.Request("POST","/admin/workbuddy/sessions/merge",new {confirm=true}));});AddGlobal("全部接受任务",OpenGlobalTasks);AddGlobal("执行可自动任务",OpenGlobalTasks);
            var refresh=Theme.Button("刷新积分");refresh.AutoSize=false;refresh.MinimumSize=new Size(84,Theme.ButtonHeight);refresh.Size=new Size(84,Theme.ButtonHeight);refresh.Margin=new Padding(0,0,4,0);refresh.Click+=async(s,e)=>await Execute(()=>Task.FromResult(0),true);toolbar.Controls.Add(refresh);toolbar.Controls.Add(autoMigrate);autoTasks.AccessibleDescription="仅控制账号池自动接受、执行与领取积分任务；不控制积分调用，不关闭定时签到。";toolbar.Controls.Add(autoTasks);modelToggle.AutoSize=false;modelToggle.MinimumSize=new Size(70,Theme.ButtonHeight);modelToggle.Size=new Size(70,Theme.ButtonHeight);modelToggle.Margin=new Padding(0,0,4,0);modelToggle.Click+=(s,e)=>{modelsExpanded=!modelsExpanded;PresentModelPage();LayoutBoard();};toolbar.Controls.Add(modelToggle);autoMigrateMenu.Click+=(s,e)=>autoMigrate.Checked=autoMigrateMenu.Checked;autoTasksMenu.Click+=(s,e)=>autoTasks.Checked=autoTasksMenu.Checked;globalMenu.Items.Add(new ToolStripSeparator());globalMenu.Items.Add(autoMigrateMenu);globalMenu.Items.Add(autoTasksMenu);foreach(var entry in new[]{"导入账号","导出账号","轮换设置"}){string action=entry;var b=Theme.Button(action);b.AutoSize=false;b.MinimumSize=new Size(WbTransferUi.ActionWidth,Theme.ButtonHeight);b.Size=new Size(WbTransferUi.ActionWidth,Theme.ButtonHeight);b.Margin=new Padding(0,0,4,0);b.Click+=async(s,e)=>await Execute(()=>action=="导入账号"?ImportAccounts():action=="导出账号"?ExportAccounts(null):RotationSettings());toolbar.Controls.Add(b);}
            autoMigrate.CheckedChanged+=async(s,e)=>{if(!binding)await Execute(SaveSettings);};autoTasks.CheckedChanged+=async(s,e)=>{if(!binding)await Execute(SaveSettings);};
            search.HandleCreated+=(s,e)=>SendMessage(search.Handle,0x1501,(IntPtr)1,"搜索 名称 / ID / UID");navigation.Controls.Add(search);navigation.Controls.Add(accountPicker);navigation.Controls.Add(pageCount);foreach(var b in new[]{first,previous,next,last}){b.AutoSize=false;b.MinimumSize=new Size(58,30);b.Size=new Size(58,30);b.Margin=Padding.Empty;navigation.Controls.Add(b);}first.Click+=(s,e)=>NavigateAccount(0);previous.Click+=(s,e)=>NavigateAccount(index-1);next.Click+=(s,e)=>NavigateAccount(index+1);last.Click+=(s,e)=>NavigateAccount(filtered.Count-1);search.TextChanged+=(s,e)=>{if(!binding)Filter(CurrentAccountId,index);};accountPicker.SelectedIndexChanged+=(s,e)=>{if(!binding&&accountPicker.SelectedIndex>=0)NavigateAccount(accountPicker.SelectedIndex);};SizeChanged+=(s,e)=>LayoutBoard();note.Text="翻页仅浏览账号；“切换此号”才改变登录。资料按页显示。";LayoutBoard();
        }
        private static string Id(IDictionary<string,object> row){return Json.Get(row,"accountId",Json.Get(row,"id"));}
        private Task OpenGlobalTasks(){using(var form=new WbTasksForm(backend,null,new Dictionary<string,object>()))form.ShowDialog(FindForm());return Task.FromResult(0);}
        private void AddGlobal(string text,Func<Task> action,bool refresh=false){var item=new ToolStripMenuItem(text);item.Click+=async(s,e)=>await Execute(action,refresh);globalMenu.Items.Add(item);}
        private async Task Execute(Func<Task> action,bool refresh=false){if(operating||!CanPresent)return;operating=true;operationCancelled=false;toolbar.Enabled=false;cards.Enabled=false;navigation.Enabled=false;SetNote(ProcessingNote,Theme.Muted);bool completed=false;string result=null;
            try{await action();if(!CanPresent)return;if(operationCancelled){SetNote("操作已取消；账号、积分与自动任务设置保持原样。",Theme.Muted);return;}completed=true;result=note.Text==ProcessingNote?"操作已完成；账号资料已刷新。":note.Text;await LoadAsync(refresh);if(!CanPresent)return;if(reload!=null)await reload();if(CanPresent)SetNote(result,Theme.Success);}
            catch(OperationCanceledException){if(CanPresent)SetNote(completed?(result??"操作已完成")+"；后续刷新等待已结束，当前页保留。":"操作等待已结束；结果尚未确认，请刷新账号池核对。",Theme.Warning);}
            catch(Exception e){if(CanPresent)SetNote(completed?(result??"操作已完成")+"；后续刷新未完成："+e.Message+"；当前页保留。":"操作未完成："+e.Message,completed?Theme.Warning:Theme.Danger);}
            finally{operating=false;if(CanPresent){toolbar.Enabled=true;cards.Enabled=true;navigation.Enabled=true;}}
        }
        private async Task SaveSettings(){await backend.Request("POST","/admin/workbuddy/settings",new {autoMigrateSessions=autoMigrate.Checked,autoTasks=autoTasks.Checked});SetNote("WB 账号池设置已保存",Theme.Success);}
        private void ShowResult(Dictionary<string,object> result){if(!CanPresent)return;using(var d=new WbReceiptForm(result))d.ShowDialog(FindForm());}
        internal void PresentBalanceRefreshReceipt(string receipt,bool attention){if(!operating)SetNote(receipt,attention?Theme.Warning:Theme.Success);}
        internal async Task LoadAsync(bool refresh=false){if(!CanPresent||backend==null)return;await loadGate.WaitAsync();try{if(!CanPresent)return;var data=await backend.Request("GET","/admin/workbuddy/summary"+(refresh?"?refresh=true":""));if(CanPresent){Present(data);if(!operating&&(note.Text==ProcessingNote||note.Text.StartsWith("账号池暂未刷新：")||note.Text.Contains("后续刷新未完成：")))SetNote("账号池资料已刷新；当前浏览账号已保留。",Theme.Success);}}catch(Exception e){SetNote("账号池暂未刷新："+e.Message+"；当前页保留",Theme.Warning);throw;}finally{loadGate.Release();}}
        internal void Present(Dictionary<string,object> data){if(!CanPresent)return;string keep=CurrentAccountId;int oldIndex=index;LastSummary=data;binding=true;try{var aggregate=NvidiaPresentation.Object(data,"totals");var settings=NvidiaPresentation.Object(data,"settings");accounts=Json.Rows(data,"accounts").ToArray();string title="池积分剩余 / 总额",amount=WbPoolUi.Credits(aggregate);decimal remaining,total;if(!decimal.TryParse(Json.Get(aggregate,"remaining"),out remaining)||!decimal.TryParse(Json.Get(aggregate,"total"),out total)){var known=accounts.Where(r=>Json.Enabled(r)&&!WbPoolUi.IsBanned(r)&&Json.Get(r,"usageStatus")!="error"&&!WbPoolUi.Flag(r,"stale")&&decimal.TryParse(Json.Get(r,"remaining"),out remaining)&&decimal.TryParse(Json.Get(r,"total"),out total)).ToArray();title="已知池积分剩余 / 总额";if(known.Length>0)amount=known.Sum(r=>decimal.Parse(Json.Get(r,"remaining"))).ToString("#,##0.###")+" / "+known.Sum(r=>decimal.Parse(Json.Get(r,"total"))).ToString("#,##0.###");}
            totals.Text=title+"（总资产）   "+amount;var callable=accounts.Where(r=>Json.Enabled(r)&&WbPoolUi.InferenceEnabled(r)&&!WbPoolUi.IsBanned(r)&&Json.Get(r,"usageStatus")!="error"&&!WbPoolUi.Flag(r,"stale")&&decimal.TryParse(Json.Get(r,"remaining"),out remaining)&&decimal.TryParse(Json.Get(r,"total"),out total)).ToArray();string callableAmount=aggregate.ContainsKey("inferenceRemaining")?WbPoolUi.Amount(aggregate,"inferenceRemaining")+" / "+WbPoolUi.Amount(aggregate,"inferenceTotal"):callable.Length>0?callable.Sum(r=>decimal.Parse(Json.Get(r,"remaining"))).ToString("#,##0.###")+" / "+callable.Sum(r=>decimal.Parse(Json.Get(r,"total"))).ToString("#,##0.###"):"待获取";aggregateNote.Text="共 "+accounts.Length+" 号 · 账号启用 "+accounts.Count(Json.Enabled)+" · 模型调用 "+Json.Get(aggregate,"inferenceEnabledAccounts",accounts.Count(WbPoolUi.InferenceEnabled).ToString())+" · 积分停用 "+Json.Get(aggregate,"inferenceDisabledAccounts",accounts.Count(r=>!WbPoolUi.InferenceEnabled(r)).ToString())+" · 封禁 "+accounts.Count(WbPoolUi.IsBanned)+Environment.NewLine+"可调用积分剩余 / 总额："+callableAmount+" · 未知不按零计";autoMigrate.Checked=WbPoolUi.Flag(settings,"autoMigrateSessions");autoTasks.Checked=WbPoolUi.Flag(settings,"autoTasks");models.Rows.Clear();foreach(var model in Json.Rows(data,"models"))models.Rows.Add(Json.Get(model,"exactModel",Json.Get(model,"model"))+" · "+Json.Get(model,"edition","cn"),Json.Strings(model,"accountIds").Length+" 个账号","积分用完 → 同型号下一账号；排除积分停用账号");modelToggle.Text=(modelsExpanded?"收起":"模型")+" ("+models.Rows.Count+")";models.Visible=modelsExpanded&&models.Rows.Count>0;
            if(keep==null)keep=Json.Get(data,"currentAccountId",Id(accounts.FirstOrDefault(r=>WbPoolUi.Flag(r,"current"))??new Dictionary<string,object>()));
        }finally{binding=false;}Filter(keep,oldIndex);LayoutBoard();}
        private void Filter(string keep,int priorIndex){string term=search.Text.Trim();filtered.Clear();filtered.AddRange(accounts.Where(a=>term.Length==0||(Json.Get(a,"label")+" "+Id(a)+" "+WbPoolUi.Uid(a)).IndexOf(term,StringComparison.OrdinalIgnoreCase)>=0));binding=true;try{accountPicker.Items.Clear();foreach(var a in filtered)accountPicker.Items.Add(Json.Get(a,"label",Id(a))+" · "+Id(a)+" · "+WbPoolUi.State(a));int found=filtered.FindIndex(a=>Id(a)==keep);index=found>=0?found:Math.Max(0,Math.Min(priorIndex,filtered.Count-1));accountPicker.SelectedIndex=filtered.Count==0?-1:index;}finally{binding=false;}ShowAccount();}
        internal void NavigateAccount(int page){if(operating)return;index=Math.Max(0,Math.Min(page,Math.Max(0,filtered.Count-1)));binding=true;try{accountPicker.SelectedIndex=filtered.Count==0?-1:index;}finally{binding=false;}ShowAccount();}
        internal void SearchAccounts(string text){search.Text=text??"";}
        internal async Task BrowseAccountAsync(string accountId){await LoadAsync();if(!CanPresent)return;binding=true;try{search.Text="";}finally{binding=false;}Filter(accountId,0);SetNote(CurrentAccountId==accountId?"已定位账号资料；仅浏览，当前登录保持不变。":"该账号尚未出现在账号池；当前登录保持不变。",Theme.Muted);}
        private void ShowAccount(){var prior=cards.Controls.OfType<WbAccountCard>().FirstOrDefault();int[] retained=prior!=null&&prior.AccountId==CurrentAccountId?prior.CaptureBrowseState():null;if(models.Parent!=null)models.Parent.Controls.Remove(models);foreach(Control c in cards.Controls.Cast<Control>().ToArray())c.Dispose();cards.Controls.Clear();if(filtered.Count==0)cards.Controls.Add(new Label {Dock=DockStyle.Fill,Text=accounts.Length==0?"当前没有保存账号。点击“账号池操作 → 添加登录”开始。":"没有匹配的账号。清空名称 / ID / UID 搜索后恢复全部账号。",TextAlign=ContentAlignment.MiddleCenter,ForeColor=Theme.Muted});else cards.Controls.Add(Card(filtered[index]));pageCount.Text="账号 "+(filtered.Count==0?0:index+1)+" / "+filtered.Count+" · 总计 "+accounts.Length;first.Enabled=previous.Enabled=filtered.Count>0&&index>0;next.Enabled=last.Enabled=filtered.Count>0&&index+1<filtered.Count;PresentModelPage();LayoutBoard();var shown=cards.Controls.OfType<WbAccountCard>().FirstOrDefault();if(shown!=null&&retained!=null)shown.RestoreBrowseState(retained);}
        private void PresentModelPage(){modelToggle.Text=(modelsExpanded?"返回资料":"模型")+" ("+models.Rows.Count+")";var card=cards.Controls.OfType<WbAccountCard>().FirstOrDefault();if(card!=null)card.ShowModels(models,modelsExpanded&&models.Rows.Count>0);else models.Visible=false;}
        private void LayoutBoard(){if(arranging||!CanPresent||ClientSize.Width<80)return;arranging=true;try{int inset=12,width=ClientSize.Width-inset*2,y=inset;bool compactToolbar=width<WbTransferUi.CompactToolbarWidth;autoMigrate.Visible=autoTasks.Visible=!compactToolbar;autoMigrateMenu.Visible=autoTasksMenu.Visible=compactToolbar;autoMigrateMenu.Checked=autoMigrate.Checked;autoTasksMenu.Checked=autoTasks.Checked;foreach(var b in toolbar.Controls.OfType<Button>()){int buttonWidth=b.Text=="账号池操作"?(compactToolbar?88:105):b.Text=="刷新积分"?(compactToolbar?70:84):b==modelToggle?70:(compactToolbar?78:WbTransferUi.ActionWidth);b.MinimumSize=new Size(buttonWidth,Theme.ButtonHeight);b.Size=new Size(buttonWidth,Theme.ButtonHeight);}modelToggle.Text=(compactToolbar?(modelsExpanded?"返回资料":"模型"):(modelsExpanded?"返回资料":"模型")+" ("+models.Rows.Count+")");modelToggle.AccessibleDescription="WB模型 "+models.Rows.Count+" 个；点击展开或返回账号资料";int toolbarHeight=Math.Max(38,toolbar.GetPreferredSize(new Size(width,0)).Height);toolbar.SetBounds(inset,y,width,toolbarHeight);y+=toolbarHeight;totals.SetBounds(inset,y,width,42);totals.Font=width<700?WbPoolUi.CompactTotalFont:WbPoolUi.TotalFont;y+=42;int aggregateHeight=Math.Max(38,TextRenderer.MeasureText(aggregateNote.Text,Font,new Size(width,0),TextFormatFlags.WordBreak|TextFormatFlags.TextBoxControl).Height+4);aggregateNote.SetBounds(inset,y,width,aggregateHeight);y+=aggregateHeight;navigation.SetBounds(inset,y,width,64);int pickerWidth=Math.Max(130,(width-8)*55/100);accountPicker.SetBounds(0,0,pickerWidth,28);search.SetBounds(pickerWidth+8,0,width-pickerWidth-8,28);search.AccessibleDescription="输入名称、账号ID或UID过滤，清空即恢复";int x=0;foreach(var b in new[]{first,previous,next,last}){b.SetBounds(x,33,58,30);x+=62;}pageCount.SetBounds(x+4,33,width-x-4,30);y+=66;int noteHeight=Math.Max(20,TextRenderer.MeasureText(note.Text,Font,new Size(width,0),TextFormatFlags.WordBreak|TextFormatFlags.TextBoxControl).Height+4);note.SetBounds(inset,ClientSize.Height-inset-noteHeight,width,noteHeight);cards.SetBounds(inset,y,width,Math.Max(100,note.Top-y-4));cards.PerformLayout();}finally{arranging=false;}}
        private Panel Card(Dictionary<string,object> row){string id=Id(row);var panel=new WbAccountCard(row);Action<string,Func<Task>> button=(text,action)=>{var b=Theme.Button(text);b.Click+=async(s,e)=>await Execute(action);panel.AddAction(b);};
            button("切换此号",async()=>{var r=await backend.Request("POST","/admin/workbuddy/accounts/"+Uri.EscapeDataString(id)+"/switch",new {confirm=true,switchClient=true});SetNote("切换结果："+Json.Get(r,"status",Json.Get(r,"effective","已保存")),Theme.Success);});
            button("积分任务",()=>Tasks(id));
            var inference=Theme.Button(WbPoolUi.InferenceEnabled(row)?"停用积分调用":"启用积分调用");inference.AccessibleDescription="仅停止或恢复该账号的积分与模型调用；模型切换与接力会跳过已停用账号。自动签到、自动任务和账号登录设置保持不变。";inference.Click+=async(s,e)=>await Execute(()=>SetInference(id,!WbPoolUi.InferenceEnabled(row)));panel.AddAction(inference);
            button("详细资料",async()=>{var data=await backend.Request("GET","/admin/workbuddy/accounts/"+Uri.EscapeDataString(id)+"/details?refresh=true");if(!CanPresent)return;var account=NvidiaPresentation.Object(data,"account");using(var d=new WbAccountDetailsForm(account.Count>0?account:row))d.ShowDialog(FindForm());});
            button("刷新此号",async()=>{var data=await backend.Request("GET","/admin/workbuddy/summary?refresh=true&accountId="+Uri.EscapeDataString(id));if(!CanPresent)return;Present(data);SetNote("账号详情已刷新",Theme.Success);});
            button("修改名称 / 备注",()=>EditProfile(row));button("导出此号",()=>ExportAccounts(id));
            button("复制 ID / UID",()=>{Clipboard.SetText("accountId: "+id+Environment.NewLine+"uid: "+WbPoolUi.Uid(row));SetNote("已复制完整账号 ID 与 UID",Theme.Success);return Task.FromResult(0);});bool marked=new[]{"manual","user_marked"}.Contains(Json.Get(NvidiaPresentation.Object(row,"ban"),"source"));
            button(marked?"清除封禁标记":"标记已封禁",async()=>{if(MessageBox.Show(FindForm(),marked?"清除本地封禁标记后重新核验？":"标记为已封禁并退出接力，保留资料供查看与删除？","账号状态",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes){CancelOperation();return;}await backend.Request("POST","/admin/workbuddy/accounts/"+Uri.EscapeDataString(id)+"/mark-status",new {status=marked?"clear":"banned",confirm=true});});
            button("删除账号",async()=>{if(MessageBox.Show(FindForm(),"删除账号 "+id+" 并清理模型/账号池引用？来源聊天与历史保留，登录凭据保存私密回滚备份。","删除账号",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes){CancelOperation();return;}await backend.Request("DELETE","/admin/accounts/"+Uri.EscapeDataString(id),new {confirm=true});SetNote("账号已删除，来源聊天保留",Theme.Success);});return panel;
        }
        private async Task SetInference(string id,bool enabled){var receipt=await backend.Request("POST","/admin/workbuddy/accounts/"+Uri.EscapeDataString(id)+"/inference",new {enabled=enabled});if(!WbPoolUi.Flag(receipt,"saved")||Json.Get(receipt,"accountId")!=id||!receipt.ContainsKey("inferenceEnabled")||!object.Equals(receipt["inferenceEnabled"],enabled))throw new InvalidOperationException("服务端尚未确认账号积分调用设置；原状态保留，请刷新核对。");if(!CanPresent)return;foreach(var account in accounts.Where(a=>Id(a)==id))account["inferenceEnabled"]=enabled;ShowAccount();SetNote(enabled?"该账号积分调用已启用；自动签到与自动任务设置保持不变。":"该账号积分调用已停用；模型切换与接力将跳过此号，自动签到与自动任务设置保持不变。",Theme.Success);}
        private async Task ImportAccounts(){using(var files=new OpenFileDialog {Title="导入 WorkBuddy 账号 · JSON / ZIP",Filter="WorkBuddy 账号文件 (*.json;*.zip)|*.json;*.zip|JSON 文件 (*.json)|*.json|ZIP 文件 (*.zip)|*.zip",Multiselect=true,CheckFileExists=true}){if(files.ShowDialog(FindForm())!=DialogResult.OK){CancelOperation();return;}var payload=WbTransferUi.ImportBody(files.FileNames,false);var preview=await backend.Request("POST","/admin/workbuddy/accounts/import/preview",payload);WbTransferUi.RequirePreview(preview);if(!CanPresent)return;using(var d=new WbImportPreviewForm(backend,payload,preview)){if(d.ShowDialog(FindForm())!=DialogResult.OK){CancelOperation();return;}SetNote("账号导入已保存：新增 "+Json.Get(d.Receipt,"imported","0")+" · 替换 "+Json.Get(d.Receipt,"replaced","0")+" · 跳过 "+Json.Get(d.Receipt,"skipped","0")+"；客户端登录与路由启用设置保持不变。",Theme.Success);}}}
        private async Task ExportAccounts(string id){if(accounts.Length==0)throw new InvalidOperationException("当前账号池为空，请先添加或导入账号。");using(var selection=new WbExportSelectionForm(accounts,id??CurrentAccountId,id!=null)){if(selection.ShowDialog(FindForm())!=DialogResult.OK){CancelOperation();return;}string format=selection.Format,extension=format=="zip"?"zip":"json";using(var save=new SaveFileDialog {Title="保存账号导出文件",Filter=format=="zip"?"ZIP 账号包 (*.zip)|*.zip":"WorkBuddy 账号 JSON (*.json)|*.json",DefaultExt=extension,AddExtension=true,OverwritePrompt=true,FileName="workbuddy-auths-"+selection.AccountIds.Length+"-"+DateTime.Now.ToString("yyyyMMdd")+"."+extension}){if(save.ShowDialog(FindForm())!=DialogResult.OK){CancelOperation();return;}int count=await WbTransferUi.ExportToFile(backend,selection.AccountIds,format,save.FileName);SetNote("已导出 "+count+" 个账号至："+Path.GetFullPath(save.FileName)+"；导出文件包含登录凭据，请仅保存在本机私有位置。",Theme.Success);}}}
        private async Task EditProfile(Dictionary<string,object> row){string id=Id(row);using(var d=new WbProfileForm(backend,id,Json.Get(row,"label"),Json.Get(row,"notes"))){if(d.ShowDialog(FindForm())!=DialogResult.OK){CancelOperation();return;}if(CanPresent)SetNote("账号名称与备注已保存；登录、积分开关和自动任务设置保持不变。",Theme.Success);}}
        private async Task RotationSettings(){var data=await backend.Request("GET","/admin/workbuddy/rotation");if(!CanPresent)return;using(var d=new WbRotationForm(backend,data))d.ShowDialog(FindForm());SetNote("轮换设置已关闭；自动轮换仅按已保存设置执行，不中断正在进行的请求。",Theme.Success);}
        private async Task CaptureSession(){using(var d=new JsonDialog("保存客户端当前登录",new Dictionary<string,object>{{"id","wb-"+DateTime.Now.ToString("MMddHHmmss")},{"label","WorkBuddy 账号"}})){if(d.ShowDialog(FindForm())!=DialogResult.OK){CancelOperation();return;}await backend.Request("POST","/admin/workbuddy/capture",d.Value);SetNote("当前登录已独立保存",Theme.Success);}}
        private async Task Login(){using(var d=new WbLoginForm(backend))d.ShowDialog(FindForm());await LoadAsync();}
        private Task Tasks(string id){if(!CanPresent)return Task.FromResult(0);var row=accounts.FirstOrDefault(a=>Id(a)==id);var data=row==null?new Dictionary<string,object>():new Dictionary<string,object>(NvidiaPresentation.Object(row,"tasks"));if(!data.ContainsKey("tasks")&&data.ContainsKey("items"))data["tasks"]=data["items"];using(var d=new WbTasksForm(backend,id,data))d.ShowDialog(FindForm());return Task.FromResult(0);}
        protected override void Dispose(bool disposing){if(disposing){globalMenu.Dispose();models.Dispose();}base.Dispose(disposing);}
    }
    internal static class WbTransferUi {
        internal const int CompactToolbarWidth=560,ActionWidth=84,DialogWidth=800,DialogHeight=620,LabelWidth=180,FieldWidth=300,ImportBytes=4*1024*1024,ImportFiles=32;
        internal static Dictionary<string,object> ImportBody(string[] paths,bool replace){if(paths==null||paths.Length==0||paths.Length>ImportFiles)throw new InvalidOperationException("请选择 1 至 32 个 JSON / ZIP 账号文件。");long total=0;var files=new List<object>();foreach(string path in paths){string extension=Path.GetExtension(path).ToLowerInvariant();if(extension!=".json"&&extension!=".zip")throw new InvalidOperationException("账号导入仅支持 JSON 与 ZIP 文件。");var info=new FileInfo(path);total+=info.Length;if(info.Length==0||total>ImportBytes)throw new InvalidOperationException("文件为空或总大小超过 4 MiB，请分批导入。");var bytes=File.ReadAllBytes(path);string content;if(extension==".zip")content=Convert.ToBase64String(bytes);else{content=new UTF8Encoding(false,true).GetString(bytes);if(content.Length>0&&content[0]=='\ufeff')content=content.Substring(1);}files.Add(new {format=extension==".zip"?"zip":"json",name=Path.GetFileName(path),content=content});}return new Dictionary<string,object>{{"files",files.ToArray()},{"duplicatePolicy",replace?"replace":"skip"}};}
        internal static void RequirePreview(Dictionary<string,object> value){if(!WbPoolUi.Flag(value,"preview")||!value.ContainsKey("tokenReturned")||!object.Equals(value["tokenReturned"],false))throw new InvalidOperationException("服务端尚未确认导入预览；现有账号保持原样。");}
        internal static async Task<int> ExportToFile(Gateway backend,string[] ids,string format,string path){if(ids==null||ids.Length==0||ids.Any(string.IsNullOrWhiteSpace))throw new InvalidOperationException("请至少选择一个账号。");if(format!="json"&&format!="zip"&&format!="switch-json")throw new InvalidOperationException("请选择兼容 JSON、workbuddy-switch JSON 或 ZIP 导出格式。");if(string.IsNullOrWhiteSpace(path)||!Path.IsPathRooted(path))throw new InvalidOperationException("请选择导出文件的本机绝对路径。");var result=await backend.Request("POST","/admin/workbuddy/accounts/export",new {accountIds=ids.Distinct().ToArray(),format=format});int count;if(!WbPoolUi.Flag(result,"exported")||Json.Get(result,"encoding")!="base64"||!int.TryParse(Json.Get(result,"count"),out count)||count!=ids.Distinct().Count())throw new InvalidOperationException("导出回执未匹配所选账号；目标文件尚未写入。");byte[] bytes;try{bytes=Convert.FromBase64String(Json.Get(result,"content"));}catch(FormatException){throw new InvalidOperationException("导出文件编码校验未通过；目标文件尚未写入。");}if(bytes.Length==0||bytes.Length>16*1024*1024)throw new InvalidOperationException("导出内容为空或超过大小限制；目标文件尚未写入。");string absolute=Path.GetFullPath(path),temp=absolute+".tmp-"+Guid.NewGuid().ToString("N");try{File.WriteAllBytes(temp,bytes);if(File.Exists(absolute))File.Replace(temp,absolute,null);else File.Move(temp,absolute);}finally{if(File.Exists(temp))File.Delete(temp);}return count;}
        internal static FlowLayoutPanel Footer(){return new FlowLayoutPanel {Dock=DockStyle.Bottom,WrapContents=true,AutoSize=true,Padding=new Padding(0,8,0,0)};}
        internal static void Configure(Form form,string title,Size? size=null){form.Text=title;form.Size=size??new Size(DialogWidth,DialogHeight);form.MinimumSize=new Size(620,460);form.StartPosition=FormStartPosition.CenterParent;form.Font=Theme.Body;form.BackColor=Theme.Background;form.Padding=new Padding(UiMetrics.Inset);}
        internal static Label Hint(string text,int height){return new Label {Text=text,ForeColor=Theme.Muted,Dock=DockStyle.Top,Height=height,AutoEllipsis=false};}
        internal static void Failure(Label status,Exception error){if(!status.IsDisposed){status.ForeColor=Theme.Danger;status.Text="操作未完成："+error.Message;}}
    }
    internal sealed class WbImportPreviewForm : ProductForm {
        private readonly Gateway backend;private readonly Dictionary<string,object> payload;private readonly CheckedListBox entries=new CheckedListBox {Dock=DockStyle.Fill,CheckOnClick=true,IntegralHeight=false,HorizontalScrollbar=true};
        private readonly CheckBox replace=new CheckBox {Text="替换重复账号的登录凭据（默认跳过；仅显式勾选后替换）",AutoSize=true};private readonly Label hint=WbTransferUi.Hint("",80),status=WbTransferUi.Hint("",58);private readonly Button commit=Theme.Button("导入所选账号");private bool busy,binding,valid;
        internal Dictionary<string,object> Receipt {get;private set;}
        private sealed class Item {internal int Index;internal bool Valid;internal string Text;public override string ToString(){return Text;}}
        internal WbImportPreviewForm(Gateway backend,Dictionary<string,object> payload,Dictionary<string,object> preview){this.backend=backend;this.payload=payload;WbTransferUi.Configure(this,"导入账号 · 预览后确认");entries.AccessibleName="导入预览账号列表，不显示登录凭据";replace.AccessibleDescription="默认跳过重复账号，显式勾选才替换凭据；既有账号的停用开关、自动任务和路由保持不变。";var controls=new FlowLayoutPanel {Dock=DockStyle.Top,AutoSize=true,WrapContents=true};Button all=Theme.Button("全选有效项"),none=Theme.Button("清空选择");controls.Controls.Add(all);controls.Controls.Add(none);controls.Controls.Add(replace);all.Click+=(s,e)=>{for(int i=0;i<entries.Items.Count;i++)entries.SetItemChecked(i,((Item)entries.Items[i]).Valid);};none.Click+=(s,e)=>{for(int i=0;i<entries.Items.Count;i++)entries.SetItemChecked(i,false);};replace.CheckedChanged+=async(s,e)=>{if(!binding)await PreviewAsync();};entries.ItemCheck+=(s,e)=>{if(!((Item)entries.Items[e.Index]).Valid)e.NewValue=CheckState.Unchecked;if(IsHandleCreated)BeginInvoke(new Action(UpdateCommit));};var footer=WbTransferUi.Footer();var cancel=Theme.Button("取消");footer.Controls.Add(commit);footer.Controls.Add(cancel);commit.Click+=async(s,e)=>{try{await CommitAsync();if(!IsDisposed)DialogResult=DialogResult.OK;}catch(Exception x){WbTransferUi.Failure(status,x);}};cancel.Click+=(s,e)=>DialogResult=DialogResult.Cancel;CancelButton=cancel;Controls.Add(entries);Controls.Add(controls);Controls.Add(hint);Controls.Add(status);Controls.Add(footer);status.Dock=DockStyle.Bottom;Present(preview);}
        private void Present(Dictionary<string,object> preview){WbTransferUi.RequirePreview(preview);binding=true;try{entries.Items.Clear();valid=!preview.ContainsKey("valid")||WbPoolUi.Flag(preview,"valid");foreach(var row in Json.Rows(preview,"entries")){int index;if(!int.TryParse(Json.Get(row,"index"),out index))continue;bool ok=!row.ContainsKey("valid")||WbPoolUi.Flag(row,"valid");var item=new Item {Index=index,Valid=ok,Text=Json.Get(row,"label","WorkBuddy 账号")+" · "+Json.Get(row,"edition","cn")+" · "+(WbPoolUi.Flag(row,"duplicate")?(replace.Checked?"重复，替换凭据":"重复，跳过"):"新增")+" · "+(WbPoolUi.Flag(row,"expired")?"凭据已过期":string.IsNullOrWhiteSpace(Json.Get(row,"expiresAt"))?"到期时间待核验":"到期 "+Json.Get(row,"expiresAt"))+(ok?"":" · 格式错误")};entries.Items.Add(item,ok);}hint.Text="共 "+Json.Get(preview,"count",entries.Items.Count.ToString())+" 条记录；可勾选要导入的账号。\nJSON / ZIP 兼容 account + auth 结构；这里只显示名称、版本、重复与到期状态。\n导入不切换客户端登录，不启用已有停用路由，不触发签到或模型生成。";int errors=Json.Rows(preview,"errors").Count();status.Text=valid?"预览完成；默认跳过重复账号，确认后才写入。":"预览发现 "+errors+" 项格式错误；请修正文件后重新选择，现有账号尚未改动。";status.ForeColor=valid?Theme.Muted:Theme.Warning;}finally{binding=false;}UpdateCommit();}
        private void UpdateCommit(){commit.Enabled=!busy&&valid&&entries.CheckedItems.Count>0;}
        private async Task PreviewAsync(){if(busy)return;busy=true;entries.Enabled=false;replace.Enabled=false;UpdateCommit();try{payload["duplicatePolicy"]=replace.Checked?"replace":"skip";payload.Remove("selectedIndexes");var preview=await backend.Request("POST","/admin/workbuddy/accounts/import/preview",payload);if(!IsDisposed)Present(preview);}catch(Exception x){valid=false;WbTransferUi.Failure(status,x);}finally{busy=false;if(!IsDisposed){entries.Enabled=true;replace.Enabled=true;UpdateCommit();}}}
        internal int[] SelectedIndexes {get{return entries.CheckedItems.Cast<Item>().Where(i=>i.Valid).Select(i=>i.Index).ToArray();}}
        internal async Task CommitAsync(){if(busy)throw new InvalidOperationException("上次导入操作仍在处理。");int[] selected=SelectedIndexes;if(!valid||selected.Length==0)throw new InvalidOperationException("请先完成有效预览，并至少选择一个账号。");busy=true;entries.Enabled=false;replace.Enabled=false;UpdateCommit();try{payload["duplicatePolicy"]=replace.Checked?"replace":"skip";payload["selectedIndexes"]=selected;var receipt=await backend.Request("POST","/admin/workbuddy/accounts/import/commit",payload);if(!WbPoolUi.Flag(receipt,"saved")||!receipt.ContainsKey("tokenReturned")||!object.Equals(receipt["tokenReturned"],false))throw new InvalidOperationException("服务端尚未确认导入；请关闭后刷新核对，不自动重复提交。");Receipt=receipt;if(!IsDisposed){status.ForeColor=Theme.Success;status.Text="导入已保存：新增 "+Json.Get(receipt,"imported","0")+" · 替换 "+Json.Get(receipt,"replaced","0")+" · 跳过 "+Json.Get(receipt,"skipped","0");}}finally{busy=false;if(!IsDisposed){entries.Enabled=true;replace.Enabled=true;UpdateCommit();}}}
    }
    internal sealed class WbExportSelectionForm : ProductForm {
        private readonly CheckedListBox accounts=new CheckedListBox {Dock=DockStyle.Fill,CheckOnClick=true,IntegralHeight=false,HorizontalScrollbar=true};private readonly ComboBox scope=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=150},format=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=360};private readonly string current;private readonly string[] ids;private readonly Button export=Theme.Button("选择保存位置");
        internal string[] AccountIds {get{return accounts.CheckedIndices.Cast<int>().Select(i=>ids[i]).ToArray();}}internal string Format {get{return format.SelectedIndex==1?"zip":format.SelectedIndex==2?"switch-json":"json";}}
        internal WbExportSelectionForm(Dictionary<string,object>[] rows,string current,bool onlyCurrent){this.current=current;ids=rows.Select(a=>Json.Get(a,"accountId",Json.Get(a,"id"))).ToArray();WbTransferUi.Configure(this,"导出账号 · 选择账号与文件格式");var top=new FlowLayoutPanel {Dock=DockStyle.Top,AutoSize=true,WrapContents=true};scope.Items.AddRange(new object[]{"当前浏览账号","全部账号","多选账号"});format.Items.AddRange(new object[]{"兼容 JSON（account + auth）","ZIP（每个账号一个 JSON）","workbuddy-switch JSON（官方格式）"});format.SelectedIndex=0;top.Controls.Add(scope);top.Controls.Add(format);foreach(var row in rows)accounts.Items.Add(Json.Get(row,"label",Json.Get(row,"accountId"))+" · "+Json.Get(row,"edition","cn"));scope.SelectedIndexChanged+=(s,e)=>ApplyScope();accounts.ItemCheck+=(s,e)=>{if(IsHandleCreated)BeginInvoke(new Action(()=>export.Enabled=AccountIds.Length>0));};scope.SelectedIndex=Array.IndexOf(ids,current)>=0?0:1;var hint=WbTransferUi.Hint("导出的 JSON / ZIP 包含登录凭据，仅写入下一步由你选择的本机文件。\n停用账号也可导出；导出不切换登录，不启用积分调用，不执行模型请求。",72);var footer=WbTransferUi.Footer();var cancel=Theme.Button("取消");footer.Controls.Add(export);footer.Controls.Add(cancel);export.Click+=(s,e)=>{if(AccountIds.Length>0)DialogResult=DialogResult.OK;};cancel.Click+=(s,e)=>DialogResult=DialogResult.Cancel;CancelButton=cancel;Controls.Add(accounts);Controls.Add(top);Controls.Add(hint);Controls.Add(footer);ApplyScope();}
        private void ApplyScope(){for(int i=0;i<ids.Length;i++)accounts.SetItemChecked(i,scope.SelectedIndex==1||scope.SelectedIndex==0&&ids[i]==current);accounts.Enabled=scope.SelectedIndex==2;export.Enabled=AccountIds.Length>0;}
    }
    internal sealed class WbProfileForm : ProductForm {
        private readonly Gateway backend;private readonly string id;private readonly TextBox label=new TextBox {Dock=DockStyle.Fill,MaxLength=128},notes=new TextBox {Dock=DockStyle.Fill,Multiline=true,ScrollBars=ScrollBars.Vertical,MaxLength=2000};private readonly Label status=WbTransferUi.Hint("只修改显示名称与备注；账号 ID、登录凭据和积分调用开关保持原样。",62);private readonly Button save=Theme.Button("保存名称 / 备注");private bool busy;
        internal WbProfileForm(Gateway backend,string id,string name,string memo){this.backend=backend;this.id=id;WbTransferUi.Configure(this,"修改账号名称 / 备注",new Size(720,480));label.Text=name;notes.Text=memo;var table=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=2,RowCount=2};table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));table.RowStyles.Add(new RowStyle(SizeType.Absolute,42));table.RowStyles.Add(new RowStyle(SizeType.Percent,100));table.Controls.Add(new Label {Text="显示名称",AutoSize=true},0,0);table.Controls.Add(label,1,0);table.Controls.Add(new Label {Text="备注",AutoSize=true},0,1);table.Controls.Add(notes,1,1);var footer=WbTransferUi.Footer();var cancel=Theme.Button("取消");footer.Controls.Add(save);footer.Controls.Add(cancel);save.Click+=async(s,e)=>{try{await SaveAsync();if(!IsDisposed)DialogResult=DialogResult.OK;}catch(Exception x){WbTransferUi.Failure(status,x);}};cancel.Click+=(s,e)=>DialogResult=DialogResult.Cancel;CancelButton=cancel;Controls.Add(table);Controls.Add(status);Controls.Add(footer);status.Dock=DockStyle.Bottom;}
        internal async Task SaveAsync(){if(busy)return;string name=label.Text.Trim(),memo=notes.Text;if(string.IsNullOrWhiteSpace(name))throw new InvalidOperationException("请填写显示名称。");busy=true;save.Enabled=false;try{var result=await backend.Request("POST","/admin/workbuddy/accounts/"+Uri.EscapeDataString(id)+"/profile",new {label=name,notes=memo});if(!WbPoolUi.Flag(result,"saved")||Json.Get(result,"accountId")!=id||Json.Get(result,"label")!=name||Json.Get(result,"notes")!=memo)throw new InvalidOperationException("服务端尚未确认名称与备注；原显示状态保留。");}finally{busy=false;if(!IsDisposed)save.Enabled=true;}}
    }
    internal sealed class WbRotationForm : ProductForm {
        private readonly Gateway backend;private readonly CheckBox enabled=new CheckBox {Text="启用自动轮换（默认关闭）",AutoSize=true};private readonly ComboBox target=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=WbTransferUi.FieldWidth},strategy=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=WbTransferUi.FieldWidth},edition=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=WbTransferUi.FieldWidth};
        private readonly NumericUpDown interval=Number(1,1440),cooldown=Number(0,10080),urgency=Number(0,8760),remaining=Number(0,1000000),gap=Number(0,8760);private readonly Label status=new Label {Dock=DockStyle.Bottom,Height=100,ForeColor=Theme.Muted};private readonly FlowLayoutPanel footer=WbTransferUi.Footer();private bool busy;private string savedSettings;
        internal WbRotationForm(Gateway backend,Dictionary<string,object> data){this.backend=backend;WbTransferUi.Configure(this,"WorkBuddy 自动轮换",new Size(800,720));var panel=new Panel {Dock=DockStyle.Fill,AutoScroll=true};var table=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,ColumnCount=2,Padding=Padding.Empty};table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,WbTransferUi.LabelWidth));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));panel.Controls.Add(table);target.Items.AddRange(new object[]{"仅网关（下次模型请求）","仅 CodeBuddy CLI（空闲后默认登录）","网关 + CodeBuddy CLI"});strategy.Items.AddRange(new object[]{"优先使用即将到期积分","顺序轮询可用账号"});edition.Items.AddRange(new object[]{"国内版 CN","国际版 AI"});int row=0;AddRow(table,ref row,"自动执行",enabled);AddRow(table,ref row,"轮换目标",target);AddRow(table,ref row,"账号版本",edition);AddRow(table,ref row,"策略",strategy);AddRow(table,ref row,"评估间隔（分钟）",interval);AddRow(table,ref row,"账号切换冷却（分钟）",cooldown);AddRow(table,ref row,"临期窗口（小时）",urgency);remaining.DecimalPlaces=3;AddRow(table,ref row,"最低剩余积分",remaining);AddRow(table,ref row,"最小到期差（小时）",gap);var hint=WbTransferUi.Hint("网关轮换只影响后续请求，不中断或重放现有会话。CLI 仅在心跳与进程均空闲时更新后续默认登录。\n轮换跳过停用积分调用、封禁、认证失效或余额不足账号；签到与自动任务保持原设置。\n“预览”和“立即评估”仅检查状态与选择账号，不发起模型生成。",110);Button save=Theme.Button("保存轮换设置"),preview=Theme.Button("预览候选"),evaluate=Theme.Button("立即评估"),close=Theme.Button("关闭");footer.Controls.Add(save);footer.Controls.Add(preview);footer.Controls.Add(evaluate);footer.Controls.Add(close);save.Click+=async(s,e)=>await Operate(async()=>{await SaveAsync();status.ForeColor=Theme.Success;status.Text="轮换设置已保存；"+(enabled.Checked?"已启用自动评估。":"自动轮换保持关闭。\n手动评估不自动启用轮换。");});preview.Click+=async(s,e)=>await Operate(()=>EvaluateAsync(true));evaluate.Click+=async(s,e)=>await Operate(()=>EvaluateAsync(false));close.Click+=(s,e)=>Close();Controls.Add(panel);Controls.Add(hint);Controls.Add(status);Controls.Add(footer);PresentSettings(NvidiaPresentation.Object(data,"settings"));savedSettings=Json.Text(SettingsBody());PresentEvaluation(NvidiaPresentation.Object(data,"preview"));}
        private static NumericUpDown Number(decimal min,decimal max){return new NumericUpDown {Minimum=min,Maximum=max,Width=150,DecimalPlaces=0};}
        private static void AddRow(TableLayoutPanel table,ref int row,string text,Control field){table.RowCount=row+1;table.RowStyles.Add(new RowStyle(SizeType.Absolute,42));table.Controls.Add(new Label {Text=text,Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft},0,row);field.Margin=new Padding(0,6,0,0);table.Controls.Add(field,1,row++);}
        private static void SetNumber(NumericUpDown field,IDictionary<string,object> value,string key,int fallback){decimal n;field.Value=Math.Max(field.Minimum,Math.Min(field.Maximum,decimal.TryParse(Json.Get(value,key),out n)?n:fallback));}
        private void PresentSettings(Dictionary<string,object> value){enabled.Checked=WbPoolUi.Flag(value,"enabled");target.SelectedIndex=Json.Get(value,"target")=="both"?2:Json.Get(value,"target")=="codebuddy-cli"?1:0;strategy.SelectedIndex=Json.Get(value,"strategy")=="round_robin"?1:0;edition.SelectedIndex=Json.Get(value,"edition")=="ai"?1:0;SetNumber(interval,value,"intervalMinutes",5);SetNumber(cooldown,value,"cooldownMinutes",120);SetNumber(urgency,value,"minUrgencyHours",72);SetNumber(remaining,value,"minRemainingCredits",0);SetNumber(gap,value,"minGapHours",6);}
        internal Dictionary<string,object> SettingsBody(){return new Dictionary<string,object>{{"enabled",enabled.Checked},{"target",target.SelectedIndex==2?"both":target.SelectedIndex==1?"codebuddy-cli":"gateway"},{"strategy",strategy.SelectedIndex==1?"round_robin":"expiry"},{"edition",edition.SelectedIndex==1?"ai":"cn"},{"intervalMinutes",(int)interval.Value},{"cooldownMinutes",(int)cooldown.Value},{"minUrgencyHours",(int)urgency.Value},{"minRemainingCredits",remaining.Value},{"minGapHours",(int)gap.Value}};}
        internal async Task SaveAsync(){var body=SettingsBody();var result=await backend.Request("POST","/admin/workbuddy/rotation",body);var actual=NvidiaPresentation.Object(result,"settings");if(!WbPoolUi.Flag(result,"saved")||body.Any(kv=>!actual.ContainsKey(kv.Key)||Convert.ToString(actual[kv.Key],System.Globalization.CultureInfo.InvariantCulture)!=Convert.ToString(kv.Value,System.Globalization.CultureInfo.InvariantCulture)))throw new InvalidOperationException("服务端尚未确认轮换设置；请重新读取后核对。");if(!IsDisposed){PresentSettings(actual);savedSettings=Json.Text(SettingsBody());}}
        private async Task Operate(Func<Task> action){if(busy)return;busy=true;footer.Enabled=false;status.ForeColor=Theme.Muted;status.Text="正在查询轮换状态；不发起模型生成…";try{await action();}catch(Exception e){WbTransferUi.Failure(status,e);}finally{busy=false;if(!IsDisposed)footer.Enabled=true;}}
        internal async Task EvaluateAsync(bool dryRun){if(Json.Text(SettingsBody())!=savedSettings)throw new InvalidOperationException("请先保存已修改的轮换设置，再预览或立即评估；本次未改变登录。");var result=await backend.Request("POST","/admin/workbuddy/rotation/evaluate",new {dryRun=dryRun});if(!new[]{"planned","rotated","skipped"}.Contains(Json.Get(result,"status"))||Json.Get(result,"generationRequests")!="0")throw new InvalidOperationException("轮换评估尚未取得有效回执；请重新读取状态核对。");if(!IsDisposed)PresentEvaluation(result);}
        private void PresentEvaluation(Dictionary<string,object> result){if(result.Count==0){status.Text="自动轮换默认关闭；选择目标与策略后点击保存。预览不修改任何登录。";return;}string state=Json.Get(result,"status");status.ForeColor=state=="rotated"?Theme.Success:Theme.Muted;if(state.Length==0){var cli=NvidiaPresentation.Object(result,"cli");status.Text="当前候选：可用 "+Json.Rows(result,"eligibleAccounts").Count()+" 个 · 排除 "+Json.Rows(result,"excludedAccounts").Count()+" 个\n网关 "+Json.Rows(result,"gateway").Count()+" 条路由计划 · CLI："+Json.Get(cli,"reason",Json.Get(cli,"status","待评估"))+"\n预览不修改登录；模型生成请求：0。";return;}var lines=new List<string>{state=="rotated"?"轮换已应用":state=="planned"?"已取得轮换预览":"本次保持原账号"};foreach(var item in Json.Rows(result,"results")){string name=Json.Get(item,"target")=="codebuddy-cli"?"CodeBuddy CLI":"网关";lines.Add(name+"："+Json.Get(item,"status")+" · "+Json.Get(item,"reason",Json.Get(item,"accountLabel",Json.Get(item,"accountId","无候选"))));}if(lines.Count==1)lines.Add("原因："+Json.Get(result,"reason","无可用变更"));lines.Add("模型生成请求：0；WorkBuddy 桌面登录保持不变。");status.Text=string.Join(Environment.NewLine,lines);}
    }

    internal sealed class WbReceiptForm : ProductForm {
        internal WbReceiptForm(Dictionary<string,object> result){Text="操作结果 · 服务端回执";Size=new Size(850,640);MinimumSize=new Size(600,440);StartPosition=FormStartPosition.CenterParent;BackColor=Theme.Background;Font=Theme.Body;Padding=new Padding(UiMetrics.Inset);var output=Theme.Output();output.Text=Json.Pretty(result);Controls.Add(output);var close=Theme.Button("关闭");close.Dock=DockStyle.Bottom;close.Click+=(s,e)=>Close();Controls.Add(close);}
    }
    internal sealed class WbLoginForm : ProductForm {
        private readonly Gateway backend;private readonly ComboBox edition=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=140};
        private readonly TextBox label=new TextBox {Width=240};private readonly Label status=new Label {AutoSize=true,MaximumSize=new Size(580,0),ForeColor=Theme.Muted};
        private readonly LinkLabel link=new LinkLabel {AutoSize=true,MaximumSize=new Size(580,0)};private readonly Button start=Theme.Button("打开登录 / 扫码");
        private readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer {Interval=2000};private string loginId,authorizationUrl;private bool polling,closing;
        internal WbLoginForm(Gateway backend){this.backend=backend;Text="添加 WorkBuddy 登录";Size=new Size(700,430);MinimumSize=new Size(600,400);BackColor=Theme.Background;Font=Theme.Body;Padding=new Padding(UiMetrics.Inset);StartPosition=FormStartPosition.CenterParent;var stack=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true};edition.Items.AddRange(new object[]{"国内版 CN","国际版 Global"});edition.SelectedIndex=0;stack.Controls.Add(new Label {Text="选择版本与账号备注",AutoSize=true});stack.Controls.Add(edition);stack.Controls.Add(label);stack.Controls.Add(start);stack.Controls.Add(link);stack.Controls.Add(status);Controls.Add(stack);status.Text="每个账号只需登录一次，登录完成后会独立保存在本机。\n关闭这个窗口会取消当前等待，不影响已保存的账号。";start.Click+=async(s,e)=>await Begin();link.LinkClicked+=(s,e)=>OpenAuthorization();timer.Tick+=async(s,e)=>await Poll();FormClosing+=async(s,e)=>{closing=true;timer.Stop();if(loginId!=null)try{await backend.Request("POST","/admin/workbuddy/login/cancel",new {loginId=loginId});}catch{}};FormClosed+=(s,e)=>timer.Dispose();}
        private void OpenAuthorization(){if(authorizationUrl==null)return;Uri url;if(!Uri.TryCreate(authorizationUrl,UriKind.Absolute,out url)||url.Scheme!="https")throw new InvalidOperationException("登录链接格式错误");Process.Start(new ProcessStartInfo(authorizationUrl){UseShellExecute=true});}
        private async Task Begin(){start.Enabled=false;try{var r=await backend.Request("POST","/admin/workbuddy/login/start",new {edition=edition.SelectedIndex==1?"global":"cn",label=label.Text});loginId=Json.Get(r,"loginId");authorizationUrl=Json.Get(r,"authorizationUrl");link.Text="重新打开官方登录页";status.Text="正在等待官方登录确认…";OpenAuthorization();timer.Start();}catch(Exception e){status.Text="登录未启动："+e.Message;start.Enabled=true;}}
        private async Task Poll(){if(polling||closing||loginId==null)return;polling=true;try{var r=await backend.Request("POST","/admin/workbuddy/login/poll",new {loginId=loginId});if(closing||IsDisposed)return;string state=Json.Get(r,"status");if(state=="complete"){timer.Stop();loginId=null;DialogResult=DialogResult.OK;}else if(state=="expired"){timer.Stop();start.Enabled=true;status.Text="本次登录等待已过期，点击按钮重新登录";}}catch(Exception e){if(!closing&&!IsDisposed)status.Text="登录确认暂未完成："+e.Message;}finally{polling=false;}}
    }
    internal static class WbTaskUiMetrics {
        internal const int HintHeight=92, HeadingHeight=58, PollMilliseconds=800, RetryMilliseconds=1600, MinimumRowHeight=108;
    }
    internal sealed class WbTasksForm : ProductForm {
        private readonly Gateway backend;private readonly string accountId;
        private readonly DataGridView grid=Theme.Grid("任务名称 / 代码","任务内容 / 执行条件","进度 / 奖励","接受 / 达标 / 领取","最近操作回执");
        private readonly Label hint=new Label {Dock=DockStyle.Bottom,Height=WbTaskUiMetrics.HintHeight,ForeColor=Theme.Muted,Padding=new Padding(0,8,0,0),AccessibleName="任务执行阶段与耗时"};
        private readonly Label heading=new Label {Dock=DockStyle.Top,Height=WbTaskUiMetrics.HeadingHeight,Font=WbPoolUi.HeadingFont,ForeColor=Theme.Ink};
        private readonly FlowLayoutPanel footer=new FlowLayoutPanel {Dock=DockStyle.Bottom,AutoSize=true,WrapContents=true};
        private readonly Button stop=Theme.Button("停止后续任务"),close=Theme.Button("关闭"),query=Theme.Button("重新查询");
        private readonly List<Button> actions=new List<Button>();private readonly CancellationTokenSource lifetime=new CancellationTokenSource();
        private readonly System.Windows.Forms.Timer clock=new System.Windows.Forms.Timer {Interval=1000};
        private Dictionary<string,object> lastData;private bool operating,closing,stopPending,uncertainSubmission,globalJob;private string activeJobId="",activeAction="",progressText="",activeStatus="";private DateTime elapsedSince=DateTime.UtcNow;private double elapsedBase;private int operationVersion;private bool resourcesDisposed;
        internal WbTasksForm(Gateway backend,string accountId,Dictionary<string,object> data){this.backend=backend;this.accountId=accountId;Text="WB 积分任务 · "+(string.IsNullOrEmpty(accountId)?"全部 WB 账号":accountId);Size=new Size(1240,840);MinimumSize=new Size(760,560);Font=Theme.Body;BackColor=Theme.Background;Padding=new Padding(UiMetrics.Inset);StartPosition=FormStartPosition.CenterParent;
            grid.AccessibleName="逐项任务内容、进度、接受达标领取状态和服务端回执";grid.AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.None;grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.None;grid.DefaultCellStyle.WrapMode=DataGridViewTriState.True;grid.AllowUserToResizeRows=true;grid.AllowUserToResizeColumns=true;grid.ScrollBars=ScrollBars.Both;
            int[] widths={180,230,130,160,170};for(int i=0;i<widths.Length;i++){grid.Columns[i].Width=widths[i];grid.Columns[i].MinimumWidth=90;grid.Columns[i].SortMode=DataGridViewColumnSortMode.NotSortable;}
            foreach(string verb in new[]{"accept","run","claim"}){var column=new DataGridViewButtonColumn {Name=verb,HeaderText=verb=="accept"?"接受任务":verb=="run"?"真实执行":"领取奖励",Width=90,MinimumWidth=90,FlatStyle=FlatStyle.Flat,SortMode=DataGridViewColumnSortMode.NotSortable};grid.Columns.Add(column);}
            foreach(DataGridViewColumn column in grid.Columns)column.DefaultCellStyle.WrapMode=DataGridViewTriState.True;grid.DefaultCellStyle.WrapMode=DataGridViewTriState.True;grid.RowTemplate.MinimumHeight=WbTaskUiMetrics.MinimumRowHeight;
            Shown+=async(s,e)=>{grid.AutoResizeRows(DataGridViewAutoSizeRowsMode.AllCells);await ResumeActive(false);};
            grid.CellContentClick+=async(s,e)=>{if(e.RowIndex<0||e.ColumnIndex<5||operating||uncertainSubmission||string.IsNullOrEmpty(accountId))return;var task=grid.Rows[e.RowIndex].Tag as Dictionary<string,object>;if(task==null)return;string verb=grid.Columns[e.ColumnIndex].Name;if(!CanAct(task,verb))return;await Operate(verb,Json.Get(task,"taskCode",Json.Get(task,"code")));};
            Controls.Add(grid);Controls.Add(hint);Controls.Add(footer);Controls.Add(heading);
            foreach(string action in new[]{"accept","run","claim"}){string verb=action;var b=Theme.Button(action=="accept"?"全部接受":action=="run"?"执行可自动任务":"领取已达标奖励");b.Click+=async(s,e)=>await Operate(verb,null);actions.Add(b);footer.Controls.Add(b);}
            query.Click+=async(s,e)=>{if(uncertainSubmission)await ResumeActive(true);else await Operate("query",null);};footer.Controls.Add(query);
            stop.AccessibleDescription="请求停止后续任务；当前已经提交的动作仍需等待服务端确认，不重放动作。";stop.Click+=async(s,e)=>await StopAsync();footer.Controls.Add(stop);
            close.AccessibleDescription="仅关闭窗口并结束本窗口等待；后台任务和已经提交的动作继续保留。";close.Click+=(s,e)=>Close();footer.Controls.Add(close);CancelButton=close;
            clock.Tick+=(s,e)=>RefreshProgress();Present(data);SetBusy(false);
        }
        internal static bool CanAct(Dictionary<string,object> task,string verb){if(WbPoolUi.Flag(task,"claimed")||WbPoolUi.Flag(task,"locked"))return false;if(verb=="claim")return WbPoolUi.Flag(task,"claimable")||WbPoolUi.Flag(task,"qualified");if(verb=="run")return WbPoolUi.Flag(task,"automaticExecution");if(verb=="accept")return !WbPoolUi.Flag(task,"accepted")&&new[]{"","not_accepted"}.Contains(Json.Get(task,"acceptStatus",Json.Get(task,"status")));return false;}
        private bool Alive {get{return !closing&&!IsDisposed&&!Disposing;}}
        private void SetBusy(bool value){operating=value;if(!Alive)return;foreach(var button in actions)button.Enabled=!value&&!uncertainSubmission;query.Enabled=!value;query.Text=uncertainSubmission?"重新连接（只读）":"重新查询";grid.Enabled=true;stop.Enabled=value&&!string.IsNullOrEmpty(activeJobId)&&!stopPending;close.Enabled=true;if(value)clock.Start();else clock.Stop();}
        private void SetProgress(string text,bool warning=false){if(!Alive)return;progressText=text;hint.ForeColor=warning?Theme.Warning:Theme.Muted;RefreshProgress();}
        private void RefreshProgress(){if(!Alive||!operating||string.IsNullOrEmpty(progressText))return;int seconds=Math.Max(0,(int)(elapsedBase+(DateTime.UtcNow-elapsedSince).TotalSeconds));hint.Text=progressText+"\n已用时 "+(seconds/60)+" 分 "+(seconds%60)+" 秒 · 关闭只结束本窗口等待，后台任务保留。";}
        private void Terminal(string message,bool warning=false){if(!Alive)return;SetBusy(false);hint.ForeColor=warning?Theme.Warning:Theme.Success;hint.Text=message;activeJobId="";stopPending=false;}
        private async Task Operate(string verb,string code){if(operating||!Alive)return;if(uncertainSubmission){await ResumeActive(true);return;}operationVersion++;activeAction=verb;elapsedBase=0;elapsedSince=DateTime.UtcNow;SetBusy(true);SetProgress("正在提交后台任务；已有任务列表保留，窗口可继续滚动和关闭。");
            try{var body=new Dictionary<string,object>{{"action",verb}};if(!string.IsNullOrEmpty(accountId))body["accountId"]=accountId;if(!string.IsNullOrEmpty(code))body["taskCode"]=code;
                Dictionary<string,object> job=null;bool unconfirmed=false;
                try{job=await backend.TaskRequest("POST","/admin/workbuddy/task-jobs",body,lifetime.Token);}
                catch(Exception){if(!Alive)return;unconfirmed=true;}
                if(unconfirmed){uncertainSubmission=true;SetProgress("提交回执尚未确认；只读查找已启动任务，不重复执行。",true);job=await FindActive();if(job.Count==0){SetBusy(false);hint.ForeColor=Theme.Warning;hint.Text="提交回执未确认；当前未发现活跃任务。上次任务列表已保留，点击重新连接仅核对状态，不重复提交。";return;}}
                await Follow(job);
            }catch(OperationCanceledException){if(Alive)Terminal("本窗口等待已结束；后台结果尚待确认，上次任务列表已保留。",true);}
            catch(Exception x){if(Alive){uncertainSubmission=true;SetBusy(false);hint.ForeColor=Theme.Warning;hint.Text="任务回执查询暂未完成："+x.Message+"；上次任务列表已保留，点击重新连接只读核对，不重复执行。";}}
        }
        private async Task<Dictionary<string,object>> FindActive(){var data=await backend.TaskRequest("GET","/admin/workbuddy/task-jobs"+(string.IsNullOrEmpty(accountId)?"":"?accountId="+Uri.EscapeDataString(accountId)),null,lifetime.Token);return NvidiaPresentation.Object(data,"job");}
        private async Task ResumeActive(bool explicitReconnect){if(operating||!Alive)return;operationVersion++;SetBusy(true);elapsedBase=0;elapsedSince=DateTime.UtcNow;if(explicitReconnect)SetProgress("正在只读查找后台任务；不会重新提交执行动作。");
            try{var job=await FindActive();if(!Alive)return;if(job.Count==0){bool wasUncertain=uncertainSubmission;uncertainSubmission=false;SetBusy(false);if(explicitReconnect||wasUncertain){hint.ForeColor=Theme.Warning;hint.Text="当前未发现活跃任务；上次任务列表已保留。可重新查询官方状态，先核对回执再决定是否执行。";}return;}await Follow(job);}
            catch(OperationCanceledException){if(Alive)SetBusy(false);}
            catch(Exception x){if(Alive){uncertainSubmission=true;SetBusy(false);hint.ForeColor=Theme.Warning;hint.Text="后台任务状态暂未取得："+x.Message+"；上次任务列表已保留，点击重新连接只读恢复。";}}
        }
        private static string Phase(string value){switch(value){case "queued":return "后台已排队";case "init":case "starting":return "准备任务";case "query":case "querying":return "查询官方任务";case "accept":case "accepting":return "接受任务";case "execution":case "run":case "executing":case "running":return "执行真实任务";case "claim":case "claiming":return "领取达标奖励";case "progress_poll":case "refresh":case "refreshing":return "核对官方状态";case "finished":return "任务收尾";case "cancelling":return "等待当前已提交动作确认";case "waiting_confirmation":return "等待当前已提交动作确认";default:return string.IsNullOrEmpty(value)?"后台处理中":value;}}
        private bool ApplyJob(Dictionary<string,object> job){string id=Json.Get(job,"jobId");if(string.IsNullOrEmpty(id)||(!string.IsNullOrEmpty(accountId)&&!string.IsNullOrEmpty(Json.Get(job,"accountId"))&&Json.Get(job,"accountId")!=accountId))throw new InvalidOperationException("服务端任务回执与当前账号不一致。");activeJobId=id;globalJob=string.IsNullOrEmpty(Json.Get(job,"accountId"));stop.Text=globalJob?"停止整个批次":"停止后续任务";stop.AccessibleDescription=globalJob?"请求停止本批次全部账号后续任务；当前已提交动作仍需等待服务端确认。":"请求停止此账号后续任务；当前已提交动作仍需等待服务端确认。";activeAction=Json.Get(job,"action",activeAction);uncertainSubmission=false;
            var snapshot=NvidiaPresentation.Object(job,"snapshot");if(snapshot.Count>0)Present(snapshot);var progress=NvidiaPresentation.Object(job,"progress");double ms;elapsedBase=Math.Max(elapsedBase+(DateTime.UtcNow-elapsedSince).TotalSeconds,double.TryParse(Json.Get(progress,"elapsedMs","0"),out ms)?Math.Max(0,ms/1000):0);elapsedSince=DateTime.UtcNow;
            string state=Json.Get(job,"status"),code=Json.Get(progress,"taskCode"),phase=Phase(Json.Get(progress,"phase"));int done=ActivityData.Int(progress,"completed",0),total=ActivityData.Int(progress,"total",0);
            if(new[]{"completed","cancelled","failed","timed_out"}.Contains(state)){var result=NvidiaPresentation.Object(job,"result");if(result.Count>0)Present(result);var error=NvidiaPresentation.Object(job,"error");
                Terminal(state=="completed"?"后台任务已完成；已逐项呈现服务端回执。任务达标与奖励到账分别核验，待确认项仍保持待确认。":state=="cancelled"?"后台已确认停止；已提交动作的回执保留，未继续后续任务。":state=="timed_out"?"后台等待已超时；已收到的任务和回执保留，未自动重试执行。":"后台任务未完成："+Json.Get(error,"message",Json.Get(error,"code","请核对逐项回执"))+"；上次任务列表已保留。",state!="completed");return true;}
            activeStatus=state;bool cancelling=state=="cancelling";if(cancelling)stopPending=true;SetBusy(true);SetProgress((globalJob&&!string.IsNullOrEmpty(accountId)?"当前接管全部 WB 账号批次（停止会影响整个批次） · ":"")+(cancelling?"已请求停止；正在等待当前已提交动作确认，不重放动作。":phase)+(string.IsNullOrEmpty(code)?"":" · 当前任务："+code+(globalJob?" · "+Json.Get(progress,"accountId"):""))+" · 已完成 "+done+" / "+total,cancelling);return false;
        }
        private async Task Follow(Dictionary<string,object> job){int version=operationVersion;while(Alive&&operating&&version==operationVersion){if(ApplyJob(job))return;await Task.Delay(WbTaskUiMetrics.PollMilliseconds,lifetime.Token);if(!Alive||!operating||version!=operationVersion)return;
                while(Alive&&operating&&version==operationVersion){try{job=await backend.TaskRequest("GET","/admin/workbuddy/task-jobs/"+Uri.EscapeDataString(activeJobId),null,lifetime.Token);break;}
                    catch(OperationCanceledException){if(!Alive)return;SetProgress("读取进度暂时超时；正在只读重连，后台任务仍保留，不重放动作。",true);}
                    catch(Exception x){if(!Alive)return;if(x.Data.Contains("httpStatus")&&Convert.ToInt32(x.Data["httpStatus"])==404){uncertainSubmission=true;SetBusy(false);hint.ForeColor=Theme.Warning;hint.Text="后台暂未找到原任务回执；上次任务列表已保留，不自动重放。点击重新连接核对状态。";return;}SetProgress("进度连接暂时中断；正在只读重连，后台任务与已有回执保留。",true);}
                    await Task.Delay(WbTaskUiMetrics.RetryMilliseconds,lifetime.Token);
                }
            }}
        private async Task StopAsync(){if(!Alive||!operating||stopPending||string.IsNullOrEmpty(activeJobId))return;int version=operationVersion;string id=activeJobId;stopPending=true;stop.Enabled=false;SetProgress("正在请求停止后续任务；当前已提交动作仍需等待确认，不重放动作。",true);
            try{var job=await backend.TaskRequest("POST","/admin/workbuddy/task-jobs/"+Uri.EscapeDataString(id)+"/cancel",new{},lifetime.Token);if(Alive&&operating&&operationVersion==version&&activeJobId==id)ApplyJob(job);}
            catch(Exception){if(Alive&&operating&&operationVersion==version&&activeJobId==id){stopPending=activeStatus=="cancelling";stop.Enabled=!stopPending;SetProgress(stopPending?"后台已确认正在停止；继续等待当前已提交动作确认，不重放。":"停止请求回执尚未确认；继续只读查询后台，不自动重发停止或执行动作。",true);}}
        }
        protected override void OnFormClosing(FormClosingEventArgs e){base.OnFormClosing(e);if(!e.Cancel){closing=true;lifetime.Cancel();clock.Stop();}}
        protected override void Dispose(bool disposing){if(disposing&&!resourcesDisposed){resourcesDisposed=true;closing=true;operating=false;lifetime.Cancel();clock.Dispose();}base.Dispose(disposing);}
        private string RowKey(Dictionary<string,object> task){return (string.IsNullOrEmpty(accountId)?Json.Get(task,"accountId"):"")+"\n"+Json.Get(task,"taskCode",Json.Get(task,"code"));}
        private void Present(Dictionary<string,object> data){lastData=data;var rows=Json.Rows(data,"tasks").ToArray();if(rows.Length==0)rows=Json.Rows(NvidiaPresentation.Object(data,"tasks"),"items").ToArray();if(rows.Length==0)rows=Json.Rows(data,"results").SelectMany(r=>Json.Rows(r,"tasks")).ToArray();
            if(!string.IsNullOrEmpty(accountId))rows=rows.Where(t=>string.IsNullOrEmpty(Json.Get(t,"accountId"))||Json.Get(t,"accountId")==accountId).ToArray();
            int scroll=grid.FirstDisplayedScrollingRowIndex,horizontal=grid.HorizontalScrollingOffset;var selected=grid.CurrentRow==null?null:grid.CurrentRow.Tag as Dictionary<string,object>;string selectedCode=selected==null?"":RowKey(selected);int selectedColumn=grid.CurrentCell==null?0:grid.CurrentCell.ColumnIndex;var receipts=Json.Rows(data,"receipts").ToArray();
            grid.SuspendLayout();try{foreach(var task in rows){string code=Json.Get(task,"taskCode",Json.Get(task,"code"));var receipt=NvidiaPresentation.Object(task,"lastReceipt");if(receipt.Count==0)receipt=receipts.LastOrDefault(r=>Json.Get(r,"taskCode")==code&&(!string.IsNullOrEmpty(accountId)||string.IsNullOrEmpty(Json.Get(task,"accountId"))||Json.Get(r,"accountId")==Json.Get(task,"accountId")))??new Dictionary<string,object>();
                string accepted=WbPoolUi.Flag(task,"accepted")||new[]{"accepted","in_progress","claimed"}.Contains(Json.Get(task,"acceptStatus"))?"已接受":"尚未接受";string qualified=WbPoolUi.Flag(task,"qualified")||WbPoolUi.Flag(task,"claimable")||WbPoolUi.Flag(task,"claimed")?"已达标":"未达标";
                string execution=WbPoolUi.Flag(task,"automaticExecution")?"已接入真实执行器":"请实际使用对应功能；此处支持接受及达标领取";
                object[] values={Json.Get(task,"title",Json.Get(task,"name",code))+Environment.NewLine+code+(string.IsNullOrEmpty(accountId)?"\n"+Json.Get(task,"accountId"):""),Json.Get(task,"description","服务端未提供任务说明")+Environment.NewLine+execution,WbPoolUi.Progress(task)+Environment.NewLine+WbPoolUi.Reward(task),accepted+" · "+qualified+Environment.NewLine+WbPoolUi.TaskState(task)+"\n官方状态："+Json.Get(task,"serverStatus",Json.Get(task,"status","未返回")),WbPoolUi.Receipt(receipt),!string.IsNullOrEmpty(accountId)&&CanAct(task,"accept")?"接受":"—",!string.IsNullOrEmpty(accountId)&&CanAct(task,"run")?"执行":"需实际使用",!string.IsNullOrEmpty(accountId)&&CanAct(task,"claim")?"领取":"—"};
                var row=grid.Rows.Cast<DataGridViewRow>().FirstOrDefault(r=>{var t=r.Tag as Dictionary<string,object>;return t!=null&&RowKey(t)==RowKey(task);});if(row==null)row=grid.Rows[grid.Rows.Add(values)];else for(int i=0;i<values.Length;i++)if(!object.Equals(row.Cells[i].Value,values[i]))row.Cells[i].Value=values[i];row.Tag=task;row.MinimumHeight=WbTaskUiMetrics.MinimumRowHeight;for(int c=0;c<5;c++)row.Cells[c].Style.WrapMode=DataGridViewTriState.True;row.Cells[3].Style.ForeColor=WbPoolUi.Flag(task,"claimed")?Theme.Success:Theme.Ink;
            }}finally{grid.ResumeLayout();}
            if(!string.IsNullOrEmpty(selectedCode)){var selectedRow=grid.Rows.Cast<DataGridViewRow>().FirstOrDefault(r=>{var t=r.Tag as Dictionary<string,object>;return t!=null&&RowKey(t)==selectedCode;});if(selectedRow!=null)grid.CurrentCell=selectedRow.Cells[Math.Min(selectedColumn,grid.Columns.Count-1)];}
            if(scroll>=0&&scroll<grid.Rows.Count)grid.FirstDisplayedScrollingRowIndex=scroll;grid.HorizontalScrollingOffset=horizontal;
            heading.Text=(string.IsNullOrEmpty(accountId)?"全部 WB 账号 · 按账号依次执行，关闭可保留后台任务":"账号 ID："+accountId)+"\n"+grid.Rows.Count+" 项任务 · 查询 "+WbPoolUi.Time(data,"checkedAt")+" · 任务和回执逐项更新";
            if(!operating)hint.Text=rows.Length==0?"官方任务列表尚未返回；已有列表保留，不将空列表解释为已完成。":"接受、达标与领取分别显示；没有真实执行器的任务保留实际使用要求。表格支持双向滚动，关闭不会取消后台任务。";
        }
    }

    internal sealed class ModelRelayForm : ProductForm {
        private readonly Gateway backend;
        private readonly CheckBox enabled=new CheckBox {Text="启用同模型自动接力",AutoSize=true};
        private readonly CheckBox wb=new CheckBox {Text="WB 模型接力（仅 WB 账号）",AutoSize=true};
        private readonly CheckBox other=new CheckBox {Text="其他模型接力（排除 WB）",AutoSize=true};
        private readonly NumericUpDown percent=new NumericUpDown {Minimum=0,Maximum=50,Width=100};
        private readonly NumericUpDown credits=new NumericUpDown {Minimum=0,Maximum=100000,Width=120};
        private readonly Label note=new Label {AutoSize=true,MaximumSize=new Size(700,0),ForeColor=Theme.Muted};
        internal ModelRelayForm(Gateway backend,Dictionary<string,object> value){
            this.backend=backend;Text="同模型自动接力 · WB / 其他";Size=new Size(930,720);MinimumSize=new Size(800,600);Font=Theme.Body;BackColor=Theme.Background;Padding=new Padding(UiMetrics.Inset);StartPosition=FormStartPosition.CenterParent;
            enabled.Checked=object.Equals(value.ContainsKey("enabled")?value["enabled"]:false,true);
            var partitions=NvidiaPresentation.Object(value,"partitions");wb.Checked=!object.Equals(partitions.ContainsKey("workbuddy")?partitions["workbuddy"]:null,false);other.Checked=!object.Equals(partitions.ContainsKey("other")?partitions["other"]:null,false);
            percent.Value=Math.Max(0,Math.Min(50,ActivityData.Int(value,"reservePercent",10)));credits.Value=Math.Max(0,Math.Min(100000,ActivityData.Int(value,"reserveCredits",100)));
            var top=new FlowLayoutPanel {Dock=DockStyle.Top,AutoSize=true,WrapContents=true,Padding=new Padding(0,0,0,12)};
            top.Controls.Add(enabled);top.Controls.Add(wb);top.Controls.Add(other);top.Controls.Add(new Label{Text="预留比例 %",AutoSize=true});top.Controls.Add(percent);top.Controls.Add(new Label{Text="预留积分",AutoSize=true});top.Controls.Add(credits);
            var filter=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=200};filter.Items.AddRange(new object[]{"WB 模型","其他模型"});top.Controls.Add(filter);
            var grid=Theme.Grid("路由","同模型组","平台 / 目标","状态 / 原因");
            Action populate=()=>{grid.Rows.Clear();foreach(var group in Json.Rows(value,"groups")){string partition=Json.Get(group,"partition",Json.Rows(group,"targets").Any(t=>Json.Get(t,"platform")=="workbuddy")?"workbuddy":"other");if(partition!=(filter.SelectedIndex==0?"workbuddy":"other"))continue;foreach(var target in Json.Rows(group,"targets"))grid.Rows.Add(Json.Get(group,"routeId"),Json.Get(group,"modelFamily"),Json.Get(target,"platform")+" / "+Json.Get(target,"upstreamId"),Json.Get(target,"state")+" · "+Json.Get(target,"reasonCode"));}};
            filter.SelectedIndexChanged+=(s,e)=>populate();filter.SelectedIndex=0;
            var footer=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=140};note.Text="WB 与其他供应严格分池：WB 只接力 WB，其他供应之间同型号接力且排除 WB。仅选择真实能力与请求兼容的供应；停用路由不复活。预留积分是网关策略，不是官方额度。";footer.Controls.Add(note);
            var save=Theme.Button("保存接力设置");var cancel=Theme.Button("取消");footer.Controls.Add(save);footer.Controls.Add(cancel);cancel.Click+=(s,e)=>DialogResult=DialogResult.Cancel;
            save.Click+=async(s,e)=>{save.Enabled=false;try{await SaveAsync();DialogResult=DialogResult.OK;}catch(Exception x){note.Text="保存失败："+x.Message;}finally{save.Enabled=true;}};
            Controls.Add(grid);Controls.Add(top);Controls.Add(footer);
        }
        internal async Task SaveAsync(){var body=GatewayTools.RelayBody(enabled.Checked,percent.Value,credits.Value);body["partitions"]=new {workbuddy=wb.Checked,other=other.Checked};await backend.Request("POST","/admin/model-relay",body);}
    }
    internal static class FreeProviderUiMetrics {
        internal const int PlatformLabelWidth=90, AccountLabelWidth=84, RevealWidth=100, HintHeight=58, CloudHintHeight=76, FooterHeight=98, KeyMaxLength=16384;
    }
    internal sealed class FreeProviderForm : ProductForm {
        private readonly Gateway backend;
        private readonly Dictionary<string,object>[] providers;
        private readonly ComboBox picker=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Fill,AccessibleName="平台"};
        private readonly TextBox account=new TextBox {Dock=DockStyle.Fill,AccessibleName="账号 ID"};
        private readonly TextBox apiKey=new TextBox {Dock=DockStyle.Fill,UseSystemPasswordChar=true,MaxLength=FreeProviderUiMetrics.KeyMaxLength,AccessibleName="API Key",AccessibleDescription=""};
        private readonly CheckBox showKey=new CheckBox {Text="显示 Key",Dock=DockStyle.Right,Width=FreeProviderUiMetrics.RevealWidth,AccessibleName="显示或隐藏 API Key"};
        private readonly TextBox cloudAccount=new TextBox {Dock=DockStyle.Fill,AccessibleName="Cloudflare Account ID"};
        private readonly Label cloudLabel=new Label {Text="Account ID",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft};
        private readonly Label hint=new Label {Dock=DockStyle.Fill,ForeColor=Theme.Muted,TextAlign=ContentAlignment.MiddleLeft};
        private readonly TableLayoutPanel top=new TableLayoutPanel {Dock=DockStyle.Top,AutoSize=true,ColumnCount=4,RowCount=4,Padding=new Padding(0,0,0,12)};
        private readonly SplitContainer middle=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(780,400),SplitterDistance=185};
        private readonly FlowLayoutPanel footer=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=FreeProviderUiMetrics.FooterHeight};
        private readonly CheckedListBox models=new CheckedListBox {Dock=DockStyle.Fill,CheckOnClick=true,BorderStyle=BorderStyle.None,BackColor=Theme.Surface};
        private readonly TextBox info=Theme.Output();
        private readonly Label message=new Label {AutoSize=true,MaximumSize=new Size(730,0),ForeColor=Theme.Muted};
        private string[] modelIds=new string[0];
        private bool[] modelSelectable=new bool[0];
        private readonly Button addButton=Theme.Button("添加所选平台");
        private bool busy,closing;
        internal FreeProviderForm(Gateway backend,Dictionary<string,object> value) {
            this.backend=backend;providers=Json.Rows(value,"providers").ToArray();
            info.WordWrap=true;info.ScrollBars=ScrollBars.Vertical;
            Text="免费平台入口 · API Key";Size=new Size(880,750);MinimumSize=new Size(800,700);
            StartPosition=FormStartPosition.CenterParent;Font=Theme.Body;Padding=new Padding(UiMetrics.Inset);BackColor=Theme.Background;
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,FreeProviderUiMetrics.PlatformLabelWidth));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,55));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,FreeProviderUiMetrics.AccountLabelWidth));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,45));
            top.RowStyles.Add(new RowStyle(SizeType.Absolute,Theme.Row));top.RowStyles.Add(new RowStyle(SizeType.Absolute,Theme.Row));
            top.RowStyles.Add(new RowStyle(SizeType.Absolute,0));top.RowStyles.Add(new RowStyle(SizeType.Absolute,FreeProviderUiMetrics.HintHeight));
            top.Controls.Add(new Label {Text="平台",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft},0,0);top.Controls.Add(picker,1,0);
            top.Controls.Add(new Label {Text="账号 ID",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft},2,0);top.Controls.Add(account,3,0);
            top.Controls.Add(new Label {Text="API Key",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft},0,1);
            var keyRow=new Panel {Dock=DockStyle.Fill};keyRow.Controls.Add(apiKey);keyRow.Controls.Add(showKey);top.Controls.Add(keyRow,1,1);top.SetColumnSpan(keyRow,3);
            top.Controls.Add(cloudLabel,0,2);top.Controls.Add(cloudAccount,1,2);top.SetColumnSpan(cloudAccount,3);
            top.Controls.Add(hint,0,3);top.SetColumnSpan(hint,4);
            showKey.CheckedChanged+=(s,e)=>{if(!closing&&!IsDisposed&&!apiKey.IsDisposed)apiKey.UseSystemPasswordChar=!showKey.Checked;};
            middle.Panel1.Controls.Add(info);middle.Panel2.Controls.Add(models);
            models.ItemCheck+=(s,e)=>{if(e.NewValue==CheckState.Checked&&e.Index<modelSelectable.Length&&!modelSelectable[e.Index])e.NewValue=CheckState.Unchecked;};
            var close=Theme.Button("关闭");footer.Controls.Add(addButton);footer.Controls.Add(close);footer.SetFlowBreak(close,true);footer.Controls.Add(message);
            close.Click+=(s,e)=>Close();
            addButton.Click+=async(s,e)=>{
                try {await AddAsync();UpdateUi(()=>{if(!closing&&!IsDisposed){message.Text="入口已保存；实际认证与可调用状态以后台核验为准";DialogResult=DialogResult.OK;}});}
                catch(Exception) {UpdateUi(()=>{if(!closing&&!IsDisposed)message.Text="添加失败：请检查 API Key、账号 ID 与平台额外字段后重试。";});}
            };
            foreach(var provider in providers)picker.Items.Add(Json.Get(provider,"name",Json.Get(provider,"id")));
            picker.SelectedIndexChanged+=(s,e)=>ShowProvider();Controls.Add(middle);Controls.Add(top);Controls.Add(footer);
            if(providers.Length>0)picker.SelectedIndex=0;
            else {addButton.Enabled=false;cloudLabel.Visible=false;cloudAccount.Visible=false;message.Text="当前没有可添加平台目录，请稍后刷新";}
        }
        private bool CanAddSelected() {return picker.SelectedIndex>=0&&picker.SelectedIndex<providers.Length&&!new[]{"retired","non_chat","configuration_required","reuse_existing"}.Contains(Json.Get(providers[picker.SelectedIndex],"availability"));}
        private void SetBusy(bool value) {
            busy=value;if(closing||IsDisposed)return;
            picker.Enabled=account.Enabled=apiKey.Enabled=cloudAccount.Enabled=showKey.Enabled=models.Enabled=!value;
            addButton.Enabled=!value&&CanAddSelected();
        }
        private void ClearCredentials() {
            if(!apiKey.IsDisposed){apiKey.Clear();if(!closing)apiKey.UseSystemPasswordChar=true;}
            if(!cloudAccount.IsDisposed)cloudAccount.Clear();
            if(!showKey.IsDisposed)showKey.Checked=false;
        }
        private void ShowProvider() {
            ClearCredentials();if(picker.SelectedIndex<0)return;
            var provider=providers[picker.SelectedIndex];bool cloudflare=Json.Get(provider,"id")=="cloudflare";
            account.Text=Json.Get(provider,"id")+"-main";cloudLabel.Visible=cloudAccount.Visible=cloudflare;
            top.RowStyles[2].Height=cloudflare?Theme.Row:0;top.RowStyles[3].Height=cloudflare?FreeProviderUiMetrics.CloudHintHeight:FreeProviderUiMetrics.HintHeight;
            hint.Text=(cloudflare?"Cloudflare 需同时填写 Account ID。":"")+"直接粘贴 API Key，后台自动保存为本机私有文件；留空仅添加待配置入口（可匿名平台按其模式接入）。勾选模型不等于真实生成已验证。";
            info.Text=GatewayTools.ProviderSummary(provider);info.Select(0,0);models.Items.Clear();
            var rows=Json.Rows(provider,"models").ToArray();
            modelIds=rows.Length>0?rows.Select(model=>Json.Get(model,"id")).ToArray():Json.Strings(provider,"models");
            modelSelectable=rows.Length>0?rows.Select(model=>!model.ContainsKey("importable")||object.Equals(model["importable"],true)).ToArray():modelIds.Select(id=>true).ToArray();
            for(int i=0;i<modelIds.Length;i++)models.Items.Add(modelIds[i]+(modelSelectable[i]?" · 待核验":" · 非导入候选"),false);
            addButton.Enabled=!busy&&CanAddSelected();message.Text="只修改所选平台入口，原有账号、路由和停用状态保留。";
        }
        internal async Task AddAsync() {
            if(busy)throw new InvalidOperationException("入口正在保存，请等待本轮提交完成。");
            Dictionary<string,object> body=null;
            try {
                if(!CanAddSelected())throw new InvalidOperationException("请选择可添加平台。");
                var selected=models.CheckedIndices.Cast<int>().Select(index=>modelIds[index]).ToArray();
                body=GatewayTools.ProviderKeyBody(Json.Get(providers[picker.SelectedIndex],"id"),account.Text,apiKey.Text,cloudAccount.Text,selected);
                SetBusy(true);ClearCredentials();
                // Only the existing authenticated loopback admin transport sees the transient credential body.
                // Response fields and backend exception text are intentionally never copied into this dialog.
                await backend.Request("POST","/admin/free-provider-add",body);
            }
            catch(Exception) {throw new InvalidOperationException("请检查 API Key、账号 ID 与平台额外字段后重试。");}
            finally {if(body!=null){body.Remove("apiKey");body.Remove("accountId");}UpdateUi(()=>{ClearCredentials();SetBusy(false);});}
        }
        protected override void OnFormClosing(FormClosingEventArgs e) {closing=true;ClearCredentials();base.OnFormClosing(e);if(e.Cancel){closing=false;ClearCredentials();}}
        protected override void Dispose(bool disposing) {if(disposing){closing=true;ClearCredentials();}base.Dispose(disposing);}
    }
    internal sealed class ClientUpdatesBoard : Panel {
        private readonly Gateway backend;
        private readonly DataGridView grid;
        private readonly Label summary;
        private readonly Button refresh, check,retry;
        private readonly TextBox updateDetail=Theme.Output();
        private bool loading;

        internal ClientUpdatesBoard(Gateway backend) {
            this.backend = backend;
            DoubleBuffered = true; BackColor = Theme.Background; Padding = new Padding(Theme.Padding);
            AccessibleRole = AccessibleRole.Grouping; AccessibleName = "软件更新监测";
            AccessibleDescription = "每天检查被反代的桌面客户端是否有新版本；只读取版本信息，不下载、不安装。";

            var bar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,MinimumSize=new Size(0,54), BackColor = Theme.Background, WrapContents = true };
            refresh = Theme.Button("刷新列表");
            check = Theme.Button("联网检查版本");retry=Theme.Button("只重试失败项");retry.Click+=async(s,e)=>await CheckAsync(true);
            check.BackColor = Theme.Accent; check.ForeColor = Color.White;
            var openButton = Theme.Button("打开所选");
            var shortcutButton = Theme.Button("创建桌面快捷方式");
            summary = new Label { AutoSize = true, ForeColor = Theme.Muted, Font = Theme.Body, Margin = new Padding(16, 14, 0, 0), Text = "尚未读取" };
            refresh.Click += async (s, e) => await LoadAsync();
            check.Click += async (s, e) => await CheckAsync(false);
            openButton.Click += (s, e) => OpenSelected();
            shortcutButton.Click += (s, e) => CreateShortcuts(false);
            bar.Controls.Add(refresh); bar.Controls.Add(check);bar.Controls.Add(retry); bar.Controls.Add(openButton); bar.Controls.Add(shortcutButton); bar.Controls.Add(summary);

            grid = Theme.Grid("软件", "已装版本", "最新版本", "状态", "来源", "最后检查", "说明");
            grid.CellFormatting += (s, e) => {
                if (e.RowIndex < 0 || e.ColumnIndex != 3) return;
                string state = Convert.ToString(grid.Rows[e.RowIndex].Cells[3].Value);
                if (state == "有新版本") { e.CellStyle.ForeColor = Theme.Warning; e.CellStyle.Font = new Font(Theme.Body, FontStyle.Bold); }
                else if (state == "已是最新") e.CellStyle.ForeColor = Theme.Success;
                else if (state == "检查失败"||state.Contains("超时")||state.Contains("错误")||state.Contains("HTTP")) e.CellStyle.ForeColor = Theme.Danger;
                else e.CellStyle.ForeColor = Theme.Muted;
            };
            grid.CellDoubleClick += (s, e) => {
                if (e.RowIndex < 0) return;
                OpenTarget(grid.Rows[e.RowIndex].Tag as Dictionary<string, object>);
            };
            grid.CellMouseDown += (s, e) => {
                if (e.Button != MouseButtons.Right || e.RowIndex < 0) return;
                grid.ClearSelection(); grid.Rows[e.RowIndex].Selected = true; grid.CurrentCell = grid.Rows[e.RowIndex].Cells[0];
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开软件", null, (s, e) => OpenSelected());
            menu.Items.Add("打开安装目录", null, (s, e) => OpenFolder());
            menu.Items.Add("打开官网", null, (s, e) => OpenHomepage());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("创建桌面快捷方式", null, (s, e) => CreateShortcuts(false));
            menu.Items.Add("为全部客户端创建快捷方式", null, (s, e) => CreateShortcuts(true));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("复制安装路径", null, (s, e) => CopyPath());
            menu.Items.Add("查看检测详情", null, (s, e) => ShowDetail());
            grid.ContextMenuStrip = menu;grid.ShowCellToolTips=true;grid.CurrentCellChanged+=(s,e)=>PresentDetail();grid.CellToolTipTextNeeded+=(s,e)=>{if(e.RowIndex>=0&&e.ColumnIndex>=0)e.ToolTipText=Convert.ToString(grid.Rows[e.RowIndex].Cells[e.ColumnIndex].Value);};
            updateDetail.WordWrap=true;updateDetail.ScrollBars=ScrollBars.Vertical;updateDetail.Font=Theme.Body;updateDetail.Text="选择一行查看完整检查结果、最近成功时间和更新源地址。";

            var hint = new Label {
                Dock = DockStyle.Bottom, Height = 46, ForeColor = Theme.Muted, Font = Theme.Body, Padding = new Padding(2, 8, 2, 0),
                Text = "成功后每日检查；失败按退避重试。只读取官方版本，不下载、不安装。双击一行直接打开对应软件；右键可打开安装目录、官网，或创建桌面快捷方式。"
            };
            var split=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1000,650),SplitterDistance=440,Panel1MinSize=160,Panel2MinSize=110};split.Panel1.Controls.Add(grid);split.Panel2.Padding=new Padding(14);split.Panel2.BackColor=Theme.Surface;split.Panel2.Controls.Add(updateDetail);Controls.Add(split); Controls.Add(bar); Controls.Add(hint);
        }

        private Dictionary<string, object> SelectedTarget() {
            return grid.CurrentRow == null ? null : grid.CurrentRow.Tag as Dictionary<string, object>;
        }

        private void OpenSelected() {
            var target = SelectedTarget();
            if (target == null) { summary.Text = "请先选中一行"; return; }
            OpenTarget(target);
        }

        private void OpenTarget(Dictionary<string, object> target) {
            if (target == null) return;
            string exe = Json.Get(target, "executable");
            if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) {
                summary.Text = "未找到启动程序：" + (string.IsNullOrEmpty(exe) ? "该客户端未配置启动入口，可右键打开安装目录" : exe);
                return;
            }
            try {
                Process.Start(new ProcessStartInfo { FileName = exe, WorkingDirectory = Path.GetDirectoryName(exe), UseShellExecute = true });
                summary.Text = "已启动 " + Json.Get(target, "name") + " · " + DateTime.Now.ToString("HH:mm:ss");
            } catch (Exception e) { summary.Text = "启动失败：" + e.Message; }
        }

        private void OpenFolder() {
            var target = SelectedTarget(); if (target == null) return;
            string dir = Json.Get(target, "installPath");
            if (Directory.Exists(dir)) Process.Start("explorer.exe", "\"" + dir + "\"");
            else summary.Text = "安装目录不存在：" + dir;
        }

        private void OpenHomepage() {
            var target = SelectedTarget(); if (target == null) return;
            string url = Json.Get(target, "homepage");
            if (string.IsNullOrEmpty(url)) { summary.Text = "该客户端没有配置官网"; return; }
            try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
            catch (Exception e) { summary.Text = "打开官网失败：" + e.Message; }
        }

        private void CopyPath() {
            var target = SelectedTarget(); if (target == null) return;
            string exe = Json.Get(target, "executable");
            if (string.IsNullOrEmpty(exe)) { summary.Text = "该客户端没有启动路径"; return; }
            Clipboard.SetText(exe); summary.Text = "已复制安装路径";
        }

        private void ShowDetail() {
            var target = SelectedTarget(); if (target == null) return;
            using (var d = new JsonDialog(Json.Get(target, "name") + " · 检测详情", target)) d.ShowDialog(this);
        }

        private void CreateShortcuts(bool all) {
            var targets = new List<Dictionary<string, object>>();
            if (all) {
                foreach (DataGridViewRow row in grid.Rows) {
                    var item = row.Tag as Dictionary<string, object>;
                    if (item != null) targets.Add(item);
                }
            } else {
                var item = SelectedTarget(); if (item != null) targets.Add(item);
            }
            if (targets.Count == 0) { summary.Text = "请先选中一行"; return; }
            int done = 0; var failed = new List<string>();
            foreach (var item in targets) {
                string exe = Json.Get(item, "executable");
                if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) { failed.Add(Json.Get(item, "name")); continue; }
                if (CreateShortcut(exe, Json.Get(item, "name"))) done++; else failed.Add(Json.Get(item, "name"));
            }
            summary.Text = "已创建 " + done + " 个桌面快捷方式" + (failed.Count > 0 ? "；跳过/失败：" + string.Join("、", failed) : "");
        }

        private static bool CreateShortcut(string exe, string name) {
            try {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string link = Path.Combine(desktop, name + ".lnk");
                object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                object shortcut = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { link });
                shortcut.GetType().InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { exe });
                shortcut.GetType().InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(exe) });
                shortcut.GetType().InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { exe + ",0" });
                shortcut.GetType().InvokeMember("Description", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { name + " · 由 AI网关创建" });
                shortcut.GetType().InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
                return File.Exists(link);
            } catch { return false; }
        }

        internal async Task LoadAsync() {
            if (loading || backend == null) return;
            loading = true;
            try { Fill(await backend.Request("GET", "/admin/client-updates")); }
            catch (Exception e) { summary.Text = "读取失败：" + e.Message; }
            finally { loading = false; }
        }

        private async Task CheckAsync(bool failedOnly=false) {
            if (loading || backend == null) return;
            loading=true;check.Enabled=retry.Enabled=false;summary.ForeColor=Theme.Muted;summary.Text="正在联网检查官方版本…";
            try {
                var pending=backend.Request("POST","/admin/client-updates/check",failedOnly?(object)new{failedOnly=true}:new{});
                while(!pending.IsCompleted&&!IsDisposed){await Task.WhenAny(pending,Task.Delay(1000));if(!pending.IsCompleted)try{Fill(await backend.Request("GET","/admin/client-updates"));}catch{}}
                var report=await pending;if(!IsDisposed)Fill(report);
            }catch(Exception e){if(!IsDisposed)summary.Text="检查暂未完成："+e.Message+"；可只重试失败项。";}
            finally{loading=false;if(!IsDisposed)check.Enabled=retry.Enabled=true;}
        }
        private void PresentDetail(){var row=SelectedTarget();if(row==null)return;updateDetail.Text=Json.Get(row,"name")+" · "+Json.Get(row,"errorLabel",StateLabel(Json.Get(row,"status")))+Environment.NewLine
            +"说明："+Json.Get(row,"errorLabel",Json.Get(row,"error",Json.Get(row,"note","—")))+Environment.NewLine
            +"完整错误："+Json.Get(row,"error","—")+" · "+Json.Get(row,"errorCode")+Environment.NewLine
            +"更新源："+Json.Get(row,"sourceUrl","未返回")+Environment.NewLine
            +"上次成功："+When(Json.Get(row,"lastSuccessAt"))+" · 版本 "+Json.Get(row,"lastSuccessLatest","—")+"；下次检查："+When(Json.Get(row,"retryDueAt",Json.Get(row,"nextCheckAt")))+Environment.NewLine
            +"本次尝试："+Json.Get(row,"attemptCount","0")+" · 重试 "+Json.Get(row,"retryCount","0")+" · "+Json.Get(row,"phase")+Environment.NewLine
            +"检查详情："+(row.ContainsKey("errorDetails")?Json.Pretty(row["errorDetails"]):"—");}

        private static string StateLabel(string status) {
            switch (status) {
                case "update_available": return "有新版本";
                case "current": return "已是最新";
                case "ahead": return "高于官方源";
                case "no_source": return "无公开来源";
                case "not_detected": return "未检测到安装";
                case "disabled": return "已停用";
                case "error": return "检查失败";
                default: return status;
            }
        }

        private static string SourceLabel(string source) {
            switch (source) {
                case "genie_update_api": return "官方更新接口";
                case "electron_updater_feed": return "官方更新源";
                case "official_json_api": return "官方接口";
                case "github_releases": return "GitHub 发布";
                case "none": return "—";
                default: return string.IsNullOrEmpty(source) ? "—" : source;
            }
        }

        private static string When(string iso) {
            DateTimeOffset value;
            return DateTimeOffset.TryParse(iso, out value) ? value.ToLocalTime().ToString("MM-dd HH:mm") : "—";
        }

        private void Fill(Dictionary<string, object> report) {
            string selected=SelectedTarget()==null?"":Json.Get(SelectedTarget(),"id");grid.Rows.Clear();
            string state = Json.Get(report, "status");
            if (state == "not_started") {
                summary.Text = "尚未检查；每天会自动检查一次，也可点「联网检查版本」";
                return;
            }
            if(state=="running")summary.Text="正在检查…";
            int updates = 0, total = 0, noSource = 0;
            foreach (var target in Json.Rows(report, "targets")) {
                total++;
                string status = Json.Get(target, "status");
                if (status == "update_available") updates++;
                if (status == "no_source") noSource++;
                string installed = Json.Get(target, "installed", "—");
                string apiVersion = Json.Get(target, "apiVersion");
                if (!string.IsNullOrEmpty(apiVersion) && apiVersion != installed) installed += "（内部 " + apiVersion + "）";
                string detail = Json.Get(target, "error");
                if (string.IsNullOrEmpty(detail)) detail = Json.Get(target, "note");
                int index = grid.Rows.Add(
                    Json.Get(target, "name"),
                    installed,
                    Json.Get(target, "latest", Json.Get(target,"lastSuccessLatest","—"))+(object.Equals(target.ContainsKey("stale")?target["stale"]:false,true)?"（上次成功）":""),
                    status=="error"?Json.Get(target,"errorLabel",StateLabel(status)):Json.Get(target,"phase")=="checking"?"正在联网":Json.Get(target,"phase")=="retry_wait"?"等待重试":StateLabel(status),
                    SourceLabel(Json.Get(target, "source")),
                    When(Json.Get(target, "checkedAt")),
                    detail);
                grid.Rows[index].Tag = target;if(Json.Get(target,"id")==selected)grid.CurrentCell=grid.Rows[index].Cells[0];
            }
            if (total == 0) { summary.Text = "清单为空"; return; }
            summary.Text = total + " 个客户端 · " + updates + " 个有新版本" + (noSource > 0 ? " · " + noSource + " 个无公开来源" : "") + " · 检查于 " + When(Json.Get(report, "checkedAt"));
            if(state=="running"){var progress=ActivityData.Child(ActivityData.Child(report,"batch"),"progress");summary.Text="正在联网 · 完成 "+Json.Get(progress,"completed","0")+" / "+Json.Get(progress,"total",total.ToString())+" · 联网 "+Json.Get(progress,"running","0")+" · 重试 "+Json.Get(progress,"retrying","0");}
            if (updates > 0) summary.ForeColor = Theme.Warning; else summary.ForeColor = Theme.Muted;PresentDetail();
        }
    }
}



namespace AiCreditDesktop {
    // Operate surface: one shared shell, compact data tables, no synthetic live metrics.
    internal sealed class OperationsBoard : Panel {
        private readonly Gateway backend;private bool loading,binding;
        private readonly TabControl sections=new TabControl {Dock=DockStyle.Fill,Font=Theme.Body};
        private readonly Label status=new Label {Dock=DockStyle.Bottom,Height=34,ForeColor=Theme.Muted,Text="刷新后显示真实运行数据。",AutoEllipsis=true};
        private readonly ComboBox strategy=new ComboBox {DropDownStyle=ComboBoxStyle.DropDownList,Width=190};
        private readonly CheckBox affinity=new CheckBox {Text="同会话优先原账号",AutoSize=true}, notifications=new CheckBox {Text="启用异常通知",AutoSize=true},trayEnabled=new CheckBox {Text="Windows 托盘提醒（本机）",AutoSize=true},showRead=new CheckBox {Text="显示已读",AutoSize=true};
        private readonly NumericUpDown ttl=new NumericUpDown {Minimum=1,Maximum=1440,Value=60,Width=75};
        private readonly DataGridView health=Theme.Grid("上游 / 模型","样本 / 成功率","首字 / P95","并发 / 冷却","状态与原因"), keys=Theme.Grid("应用 / 标识","允许模型","每日请求 / Token","并发上限","状态"),expiry=Theme.Grid("账号 / 版本","积分包","剩余积分","到期时间","核验状态"),sessions=Theme.Grid("会话标识","模型","账号 / 上游","到期时间"),notices=Theme.Grid("通知","详情","最近发生","次数","状态");
        private readonly Label windows=new Label {Dock=DockStyle.Top,Height=52,ForeColor=Theme.Ink,Padding=new Padding(10),BackColor=Theme.Soft},recommendation=new Label {Dock=DockStyle.Top,Height=52,ForeColor=Theme.Accent,Padding=new Padding(10),BackColor=Theme.Selection,AutoEllipsis=true};
        private Dictionary<string,object> data=new Dictionary<string,object>();
        private readonly System.Windows.Forms.Timer notificationTimer=new System.Windows.Forms.Timer {Interval=60000};
        private readonly HashSet<string> delivered=new HashSet<string>();private readonly string preferenceFile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"AiCreditGateway","notification-ui.json");
        internal event Action<Dictionary<string,object>> NotificationRaised;
        internal event Func<string,Task> AccountRequested;
        internal OperationsBoard(Gateway backend){this.backend=backend;Dock=DockStyle.Fill;BackColor=Theme.Background;Padding=new Padding(Theme.Padding);Font=Theme.Body;AccessibleName="运行中心";
            strategy.Items.AddRange(new object[]{"沿用配置顺序","优先稳定","优先快响应","优先即将到期积分"});strategy.SelectedIndex=0;
            var healthPage=Section("健康与选路");healthPage.Controls.Add(health);var policy=Bar();policy.Controls.Add(new Label {Text="候选选择",AutoSize=true,Margin=new Padding(0,8,8,0)});policy.Controls.Add(strategy);Add(policy,"保存选路策略",SaveSettings);Add(policy,"刷新运行状态",()=>LoadAsync());healthPage.Controls.Add(policy);healthPage.Controls.Add(Hint("仅对同模型、同能力的合格候选排序；无样本保持未知，不自动生成探测请求。"));
            var keyPage=Section("应用密钥");keyPage.Controls.Add(keys);var keyBar=Bar();Add(keyBar,"创建应用密钥",CreateKey);Add(keyBar,"撤销所选密钥",RevokeKey);keyPage.Controls.Add(keyBar);keyPage.Controls.Add(Hint("DSH、Hermes 等客户端可各用一把 Key；仅创建时显示原文，关闭后不再读取。"));
            var expiryPage=Section("会话与到期");var expirySplit=new SplitContainer {Dock=DockStyle.Fill,Orientation=Orientation.Horizontal,Size=new Size(1000,600),SplitterDistance=340,Panel1MinSize=170,Panel2MinSize=100};expirySplit.Panel1.Controls.Add(expiry);expirySplit.Panel1.Controls.Add(recommendation);expirySplit.Panel1.Controls.Add(windows);expirySplit.Panel2.Controls.Add(sessions);expirySplit.Panel2.Controls.Add(Hint("会话绑定 · 失效、额度不足或退出候选池时自动解除"));expiryPage.Controls.Add(expirySplit);var affinityBar=Bar();affinityBar.Controls.Add(affinity);affinityBar.Controls.Add(new Label {Text="保留分钟",AutoSize=true,Margin=new Padding(12,8,4,0)});affinityBar.Controls.Add(ttl);Add(affinityBar,"保存会话设置",SaveSettings);Add(affinityBar,"查看所选账号",BrowseExpiryAccount);Add(affinityBar,"查看轮换建议",PreviewRotation);expiryPage.Controls.Add(affinityBar);
            var noticePage=Section("异常通知");noticePage.Controls.Add(notices);var notificationBar=Bar();notificationBar.Controls.Add(notifications);notificationBar.Controls.Add(trayEnabled);notificationBar.Controls.Add(showRead);Add(notificationBar,"保存通知设置",SaveSettings);Add(notificationBar,"标记所选已读",ReadNotification);noticePage.Controls.Add(notificationBar);noticePage.Controls.Add(Hint("同一问题聚合；已恢复通知不重复弹出。托盘开关仅作用于当前 Windows 用户。"));showRead.CheckedChanged+=(s,e)=>PresentNotifications();trayEnabled.CheckedChanged+=(s,e)=>{if(binding)return;SeedDelivered();SaveNotificationPreference();notificationTimer.Enabled=trayEnabled.Checked;};
            Controls.Add(sections);Controls.Add(status);ReadNotificationPreference();notificationTimer.Tick+=async(s,e)=>{if(trayEnabled.Checked)await LoadAsync();};notificationTimer.Enabled=trayEnabled.Checked;Disposed+=(s,e)=>notificationTimer.Dispose();
            foreach(var grid in new[]{health,keys,expiry,sessions,notices}){grid.ShowCellToolTips=true;grid.DefaultCellStyle.WrapMode=DataGridViewTriState.False;grid.CellToolTipTextNeeded+=(s,e)=>{if(e.RowIndex>=0&&e.ColumnIndex>=0)e.ToolTipText=Convert.ToString(((DataGridView)s).Rows[e.RowIndex].Cells[e.ColumnIndex].Value);};grid.DataError+=(s,e)=>{e.ThrowException=false;};}
        }
        private TabPage Section(string title){var page=new TabPage(title){BackColor=Theme.Background,Padding=new Padding(12)};sections.TabPages.Add(page);return page;}
        private static FlowLayoutPanel Bar(){return new FlowLayoutPanel {Dock=DockStyle.Top,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,MinimumSize=new Size(0,52),Padding=new Padding(0,8,0,4),WrapContents=true};}
        private static Label Hint(string text){return new Label {Text=text,Dock=DockStyle.Top,Height=44,Padding=new Padding(0,10,0,4),ForeColor=Theme.Muted,AutoEllipsis=true};}
        private void Add(FlowLayoutPanel bar,string text,Func<Task> action){var b=Theme.Button(text);b.Click+=async(s,e)=>{b.Enabled=false;try{await action();}catch(Exception x){status.ForeColor=Theme.Danger;status.Text=x.Message;}finally{if(!b.IsDisposed)b.Enabled=true;}};bar.Controls.Add(b);}
        private static string Number(Dictionary<string,object> row,string key){return ActivityData.Number(row,key);}
        private static string Stamp(string value){DateTimeOffset time;return DateTimeOffset.TryParse(value,out time)?time.ToLocalTime().ToString("MM-dd HH:mm"):"—";}
        private static string Metric(Dictionary<string,object> row,string key){return !row.ContainsKey(key)||row[key]==null?"—":Number(row,key)+" ms";}
        private static string HealthState(string state){return state=="healthy"?"正常":state=="unknown"?"待观察":state=="cooldown"?"冷却中":state=="degraded"?"需关注":state;}
        private static string Limit(Dictionary<string,object> row,string key){double n;return double.TryParse(Json.Get(row,key),out n)&&n>0?Number(row,key):"不限";}
        private static object SelectedRow(DataGridView grid){return grid.CurrentRow==null?null:grid.CurrentRow.Tag;}
        private static void AddRow(DataGridView grid,Dictionary<string,object> row,params object[] values){int index=grid.Rows.Add(values);grid.Rows[index].Tag=row;}
        private void SeedDelivered(){foreach(var row in Json.Rows(data,"notifications"))delivered.Add(Json.Get(row,"id"));}
        private void ReadNotificationPreference(){try{if(!File.Exists(preferenceFile))return;var saved=Json.Object(File.ReadAllText(preferenceFile,Encoding.UTF8));foreach(string id in Json.Strings(saved,"delivered"))delivered.Add(id);binding=true;trayEnabled.Checked=object.Equals(saved.ContainsKey("trayEnabled")?saved["trayEnabled"]:false,true);}catch{}finally{binding=false;}}
        private void SaveNotificationPreference(){try{Directory.CreateDirectory(Path.GetDirectoryName(preferenceFile));File.WriteAllText(preferenceFile,Json.Text(new{trayEnabled=trayEnabled.Checked,delivered=delivered.Take(200).ToArray()}),new UTF8Encoding(false));}catch{status.Text="本机提醒设置尚未写入，当前会话继续生效。";}}
        internal async Task LoadAsync(){if(loading||backend==null||IsDisposed)return;loading=true;try{var next=await backend.Request("GET","/admin/operations");if(IsDisposed)return;Present(next);status.ForeColor=Theme.Muted;status.Text="运行状态已刷新 · "+Stamp(Json.Get(next,"checkedAt"))+" · 样本来自网关实际调用";}catch(Exception x){if(!IsDisposed){status.ForeColor=Theme.Warning;status.Text="读取暂未完成："+x.Message+"；已有资料保留，可刷新重试。";}}finally{loading=false;}}
        internal void Present(Dictionary<string,object> next){data=next;binding=true;try{var settings=ActivityData.Child(data,"settings");string[] names={"configured","stable","fast","expiry"};strategy.SelectedIndex=Math.Max(0,Array.IndexOf(names,Json.Get(settings,"strategy","configured")));affinity.Checked=object.Equals(settings.ContainsKey("affinityEnabled")?settings["affinityEnabled"]:false,true);notifications.Checked=object.Equals(settings.ContainsKey("notificationsEnabled")?settings["notificationsEnabled"]:false,true);decimal minutes;if(decimal.TryParse(Json.Get(settings,"affinityTtlMinutes"),out minutes))ttl.Value=Math.Max(ttl.Minimum,Math.Min(ttl.Maximum,minutes));
            health.Rows.Clear();foreach(var r in Json.Rows(data,"health")){double sample,rate;bool known=double.TryParse(Json.Get(r,"samples"),out sample)&&sample>0&&double.TryParse(Json.Get(r,"successRate"),out rate);double.TryParse(Json.Get(r,"successRate"),out rate);AddRow(health,r,Json.Get(r,"label",Json.Get(r,"upstreamId"))+" / "+Json.Get(r,"model"),known?Number(r,"samples")+" / "+(rate*100).ToString("0.0")+"%":"无调用样本",Metric(r,"firstTokenMs")+" / "+Metric(r,"p95Ms"),Number(r,"active")+" / "+Stamp(Json.Get(r,"cooldownUntil")),HealthState(Json.Get(r,"status","unknown"))+" · "+Json.Get(r,"reason"));}
            keys.Rows.Clear();foreach(var r in Json.Rows(data,"keys"))AddRow(keys,r,Json.Get(r,"name")+" / "+Json.Get(r,"prefix",Json.Get(r,"id")),Json.Strings(r,"allowedModels").Length==0?"全部已启用模型":string.Join("、",Json.Strings(r,"allowedModels")),Limit(r,"dailyRequestLimit")+" / "+Limit(r,"dailyTokenLimit"),Limit(r,"maxConcurrency"),Json.Get(r,"revokedAt").Length>0?"已撤销":"有效");
            var exp=ActivityData.Child(data,"expiry");windows.Text=string.Join("       ",Json.Rows(exp,"windows").Select(r=>(Json.Get(r,"days")=="1"?"未来 24 小时":"未来 "+Json.Get(r,"days")+" 天")+"   "+Number(r,"credits")+" 积分 / "+Number(r,"packages")+" 包"));var rec=ActivityData.Child(exp,"recommendation");recommendation.Text=rec.Count==0?"暂无可确认的到期优先账号；陈旧或未知余额不参与建议。":"建议优先使用 "+Json.Get(rec,"label",Json.Get(rec,"accountId"))+" · "+Number(rec,"remaining")+" 积分 · "+Stamp(Json.Get(rec,"expiresAt"))+" 到期 · "+Json.Get(rec,"reason");expiry.Rows.Clear();foreach(var r in Json.Rows(exp,"items"))AddRow(expiry,r,Json.Get(r,"label",Json.Get(r,"accountId"))+" / "+Json.Get(r,"edition"),Json.Get(r,"packageName","积分包"),Number(r,"remaining"),Stamp(Json.Get(r,"expiresAt")),object.Equals(r.ContainsKey("stale")?r["stale"]:false,true)?"资料陈旧，待刷新":object.Equals(r.ContainsKey("eligible")?r["eligible"]:true,false)?"暂不参与推荐":"已核验 "+Stamp(Json.Get(r,"checkedAt")));
            sessions.Rows.Clear();foreach(var r in Json.Rows(data,"sessions"))AddRow(sessions,r,Json.Get(r,"sessionRef",Json.Get(r,"id")),Json.Get(r,"model",Json.Get(r,"routeId")),Json.Get(r,"accountId")+" / "+Json.Get(r,"upstreamId"),Stamp(Json.Get(r,"expiresAt")));PresentNotifications();
            foreach(var r in Json.Rows(data,"notifications")){string id=Json.Get(r,"id");bool fresh=delivered.Add(id);if(fresh&&trayEnabled.Checked&&notifications.Checked&&!object.Equals(r.ContainsKey("read")?r["read"]:false,true)&&!object.Equals(r.ContainsKey("recovered")?r["recovered"]:false,true)&&NotificationRaised!=null)NotificationRaised(r);}if(data.ContainsKey("notifications"))delivered.IntersectWith(Json.Rows(data,"notifications").Select(r=>Json.Get(r,"id")));if(trayEnabled.Checked)SaveNotificationPreference();
        }finally{binding=false;}}
        private void PresentNotifications(){notices.Rows.Clear();foreach(var r in Json.Rows(data,"notifications")){bool read=object.Equals(r.ContainsKey("read")?r["read"]:false,true);if(read&&!showRead.Checked)continue;AddRow(notices,r,Json.Get(r,"title"),Json.Get(r,"message"),Stamp(Json.Get(r,"lastSeenAt",Json.Get(r,"createdAt"))),Number(r,"count"),object.Equals(r.ContainsKey("recovered")?r["recovered"]:false,true)?"已恢复":read?"已读":"未读");}}
        private async Task SaveSettings(){string[] names={"configured","stable","fast","expiry"};await backend.Request("POST","/admin/operations/settings",new{strategy=names[Math.Max(0,strategy.SelectedIndex)],affinityEnabled=affinity.Checked,affinityTtlMinutes=(int)ttl.Value,notificationsEnabled=notifications.Checked});SaveNotificationPreference();await LoadAsync();status.ForeColor=Theme.Success;status.Text="选路、会话和通知设置已保存。";}
        private async Task BrowseExpiryAccount(){var row=SelectedRow(expiry) as Dictionary<string,object>??ActivityData.Child(ActivityData.Child(data,"expiry"),"recommendation");string id=Json.Get(row,"accountId");if(id.Length==0){status.Text="请选择一个已知积分包账号。";return;}if(AccountRequested!=null)await AccountRequested(id);}
        private async Task PreviewRotation(){var report=await backend.Request("GET","/admin/workbuddy/rotation");using(var dialog=new JsonDialog("轮换建议 · 只读预览，不改变登录",report))dialog.ShowDialog(this);}
        private async Task ReadNotification(){var row=SelectedRow(notices) as Dictionary<string,object>;if(row==null){status.Text="先选择一条通知。";return;}await backend.Request("POST","/admin/notifications/"+Uri.EscapeDataString(Json.Get(row,"id"))+"/read",new{});row["read"]=true;PresentNotifications();}
        private async Task RevokeKey(){var row=SelectedRow(keys) as Dictionary<string,object>;if(row==null){status.Text="先选择一个应用密钥。";return;}if(Json.Get(row,"revokedAt").Length>0)return;if(MessageBox.Show(this,"撤销 "+Json.Get(row,"name")+" 的密钥？该客户端后续请求将停止。","撤销应用密钥",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;await backend.Request("POST","/admin/application-keys/"+Uri.EscapeDataString(Json.Get(row,"id"))+"/revoke",new{});await LoadAsync();}
        private async Task CreateKey(){using(var d=new ProductForm {Text="创建应用密钥",Size=new Size(620,530),MinimumSize=new Size(540,500),StartPosition=FormStartPosition.CenterParent,Font=Theme.Body,BackColor=Theme.Background,Padding=new Padding(24)}){var form=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=12};var name=Input(form,"应用名称，例如 DSH");var models=Input(form,"允许模型 ID（逗号分隔；留空允许全部）");var requests=Input(form,"每日请求上限（0 表示不限）","0");var tokens=Input(form,"每日 Token 上限（0 表示不限）","0");var concurrency=Input(form,"最大并发（0 表示不限）","0");var info=new Label {AutoSize=true,ForeColor=Theme.Danger};form.Controls.Add(info);var actions=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=46,FlowDirection=FlowDirection.RightToLeft};var create=Theme.Button("创建密钥");var cancel=Theme.Button("取消");cancel.DialogResult=DialogResult.Cancel;actions.Controls.Add(create);actions.Controls.Add(cancel);Dictionary<string,object> created=null;create.Click+=async(s,e)=>{int req,tok,con;if(string.IsNullOrWhiteSpace(name.Text)||!int.TryParse(requests.Text,out req)||!int.TryParse(tokens.Text,out tok)||!int.TryParse(concurrency.Text,out con)||req<0||tok<0||con<0){info.Text="请输入应用名称和非负整数限制。";return;}create.Enabled=false;try{created=await backend.Request("POST","/admin/application-keys",new{name=name.Text.Trim(),allowedModels=models.Text.Split(new[]{',','，',' ','\n','\r'},StringSplitOptions.RemoveEmptyEntries),dailyRequestLimit=req,dailyTokenLimit=tok,maxConcurrency=con});d.DialogResult=DialogResult.OK;d.Close();}catch(Exception x){info.Text=x.Message;}finally{if(!create.IsDisposed)create.Enabled=true;}};d.Controls.Add(form);d.Controls.Add(actions);d.CancelButton=cancel;d.AcceptButton=create;if(d.ShowDialog(this)!=DialogResult.OK||created==null)return;ShowCreatedKey(Json.Get(created,"key"));await LoadAsync();}}
        private static TextBox Input(TableLayoutPanel panel,string title,string value=""){panel.Controls.Add(new Label {Text=title,AutoSize=true,Margin=new Padding(0,6,0,4)});var input=new TextBox {Text=value,Dock=DockStyle.Top,Margin=new Padding(0,0,0,8)};panel.Controls.Add(input);return input;}
        private void ShowCreatedKey(string secret){using(var d=new ProductForm {Text="密钥已创建 · 仅显示这一次",Size=new Size(640,245),MinimumSize=new Size(540,245),StartPosition=FormStartPosition.CenterParent,Font=Theme.Body,BackColor=Theme.Background,Padding=new Padding(24)}){var text=new TextBox {Text=secret,ReadOnly=true,Dock=DockStyle.Top,Font=Theme.Mono};var hint=new Label {Text="请保存到对应客户端。关闭后不再显示密钥原文。",Dock=DockStyle.Top,Height=48};var actions=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=48};var copy=Theme.Button("复制密钥");copy.Click+=(s,e)=>{try{Clipboard.SetText(text.Text);copy.Text="已复制";}catch{hint.Text="剪贴板暂未写入，可全选密钥复制。";}};var close=Theme.Button("我已保存，关闭");close.Click+=(s,e)=>d.Close();actions.Controls.Add(copy);actions.Controls.Add(close);d.Controls.Add(text);d.Controls.Add(hint);d.Controls.Add(actions);d.ShowDialog(this);text.Clear();secret=null;}}
    }
}
