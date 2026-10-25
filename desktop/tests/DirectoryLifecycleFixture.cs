using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using AiCreditDesktop;

internal static class DirectoryLifecycleFixture {
    sealed class Reply:HttpMessageHandler {
        internal int Calls,Completed;internal string Mode,Payload;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation){
            Calls++;int call=Calls;if(request.Method!=HttpMethod.Get||request.RequestUri.AbsolutePath!="/admin/model-directory")throw new Exception("unexpected operation");
            await Task.Delay(600);Completed++;bool failed=Mode=="late-error"||Mode=="retry"&&call==1;
            return new HttpResponseMessage(failed?HttpStatusCode.InternalServerError:HttpStatusCode.OK){Content=new StringContent(failed?"{\"error\":{\"message\":\"fixture read failed\"}}":Payload??"{\"providers\":[{\"id\":\"sample\",\"kind\":\"workbuddy\",\"accountId\":\"sample\",\"models\":[{\"id\":\"m\",\"name\":\"SAMPLE\",\"tools\":true}]}]}",Encoding.UTF8,"application/json")};
        }
    }
    [STAThread]static int Main(string[] args){
        string mode=args.Length>0?args[0]:"late-success";Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);int exceptions=0,exit=0;Application.ThreadException+=(s,e)=>{exceptions++;Console.WriteLine("UI_EXCEPTION "+e.Exception);};
        using(var gateway=new Gateway(null))using(var handler=new Reply{Mode=mode,Payload=mode=="capture"?File.ReadAllText(args[1],Encoding.UTF8):null})using(var client=new HttpClient(handler){BaseAddress=new Uri("http://127.0.0.1:1")})using(var form=new MainWindow(gateway,false,false))using(var timer=new System.Windows.Forms.Timer{Interval=20}){
            typeof(Gateway).GetField("client",BindingFlags.Instance|BindingFlags.NonPublic).SetValue(gateway,client);
            form.ShowInTaskbar=false;form.StartPosition=FormStartPosition.Manual;form.Location=new Point(-10000,-10000);var watch=new Stopwatch();double first=-1;bool retried=false;int heartbeat=0;
            timer.Tick+=(s,e)=>{heartbeat++;var dialog=Application.OpenForms.Cast<Form>().FirstOrDefault(f=>f.Text=="全部平台模型 · 勾选导入 DSH");if(dialog==null)return;if(first<0)first=watch.Elapsed.TotalMilliseconds;
                var panel=dialog.Controls.OfType<FlowLayoutPanel>().FirstOrDefault(p=>p.Controls.OfType<Button>().Any(b=>b.Text=="重试读取目录"));var retry=panel==null?null:panel.Controls.OfType<Button>().FirstOrDefault(b=>b.Text=="重试读取目录");
                if(mode=="retry"){if(!retried&&retry!=null&&retry.Visible){retried=true;retry.PerformClick();}var grid=dialog.Controls.OfType<DataGridView>().FirstOrDefault();if(retried&&grid!=null&&grid.Enabled&&grid.RowCount==1)dialog.Close();}
                else if(mode!="capture")dialog.Close();
            };
            form.Shown+=async(s,e)=>{watch.Start();timer.Start();try{await form.ModelDirectory(mode=="capture"?args[2]:null);await Task.Delay(800);timer.Stop();if(first<0||first>=400)throw new Exception("first dialog delayed "+first);if(exceptions!=0)throw new Exception("late response touched disposed UI");if(handler.Completed!=handler.Calls)throw new Exception("fixture request still active");if(mode=="retry"&&(!retried||handler.Calls!=2))throw new Exception("retry did not reread exactly once");if(mode!="retry"&&handler.Calls!=1)throw new Exception("close replayed request");Console.WriteLine(Json.Text(new{mode=mode,firstVisibleMs=first,heartbeatTicks=heartbeat,getCalls=handler.Calls,completed=handler.Completed,uiExceptions=exceptions,retry= retried,passed=true}));}catch(Exception x){exit=1;Console.WriteLine("DIRECTORY_LIFECYCLE_FAIL "+x.Message);}finally{timer.Stop();form.FinishSelfTest();}};
            Application.Run(form);
        }return exit;
    }
}
