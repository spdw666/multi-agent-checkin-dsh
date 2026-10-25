using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using AiCreditDesktop;

internal static class CatalogFixture {
    static Dictionary<string,object> Row(params object[] values){var r=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)r[(string)values[i]]=values[i+1];return r;}
    static Dictionary<string,object> Catalog(){
        var providers=new List<object>();
        for(int p=0;p<12;p++){
            var models=new List<object>();for(int i=0;i<80;i++)models.Add(Row("id","model-"+i,"name","模型 "+i,"tools",true,"imported",i%23==0,"importedRouteIds",i%23==0?new[]{"route-"+p+"-"+i}:new string[0]));
            providers.Add(Row("id","cn-"+p,"kind","workbuddy","accountId","cn-account-"+p,"models",models));
        }
        providers.Add(Row("id","ai-1","kind","workbuddyai","accountId","ai-account","models",Enumerable.Range(0,20).Select(i=>Row("id","model-"+i,"name","AI "+i,"tools",true)).ToArray()));
        providers.Add(Row("id","nv","kind","nvidia","accountId","nv","models",Enumerable.Range(0,400).Select(i=>Row("id","nv-"+i,"name","NVIDIA "+i,"category","chat","chat",true,"importable",true,"freeEndpoint",true)).ToArray()));
        return Row("providers",providers.ToArray());
    }
    static void Filter(DataGridView g,string label,string query,string category){
        var method=typeof(ModelDirectoryView).GetMethod("Filter",BindingFlags.Static|BindingFlags.NonPublic);if(method!=null){method.Invoke(null,new object[]{g,label,query,category});return;}
        g.CurrentCell=null;foreach(DataGridViewRow row in g.Rows){string text=Convert.ToString(row.Cells[2].Value)+" "+Convert.ToString(row.Cells[3].Value);row.Visible=(label.Length==0||Convert.ToString(row.Cells[1].Value)==label)&&(query.Length==0||text.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0)&&(category.Length==0||Convert.ToString(row.Cells[4].Value)==category);}
    }
    static int assertions=0;
    static void Assert(bool value,string message){assertions++;if(!value)throw new Exception(message);}
    static int VisibleCount(DataGridView g){return g.Rows.Cast<DataGridViewRow>().Count(x=>x.Visible);}
    static void EdgeCases(DataGridView g,ComboBox platform){
        var catalog=Row("providers",new object[]{
            Row("id","cn1","kind","workbuddy","accountId","one","error",Row("message","login needed"),"models",new object[]{Row("id","old","name","Old","source","configured_route","callable",false,"importable",false,"imported",true,"importedRouteIds",new[]{"old-route"},"privateUnrelatedField",Row("preserved",true)),Row("id","shared","name","Shared stale","callable",false,"imported",true,"importedRouteIds",new[]{"shared-route"})}),
            Row("id","cn2","kind","workbuddy","accountId","two","error",Row("message","another login needed"),"models",new object[]{Row("id","shared","name","Shared fresh","callable",true,"tools",true),Row("id","blocked","name","Blocked","callable",false,"imported",false)}),
            Row("id","global","kind","workbuddy","edition","global","accountId","global","models",new object[]{Row("id","shared","name","Global", "tools",true)}),
            Row("id","ai","kind","workbuddyai","accountId","ai","models",new object[]{Row("id","shared","name","AI","tools",true)}),
            Row("id","unknown","kind","unknown","accountId","unknown","models",new object[]{Row("id","unknown","name","Unknown")})
        });
        string original=Json.Text(catalog);int count=ModelDirectoryView.Populate(g,catalog,platform);Assert(count==6,"edge model count");Assert(g.RowCount==7,"CN errors not aggregated");Assert(platform.Items.Count==5,"global or unknown pools collapsed");
        Filter(g,"WorkBuddy 国内账号池","old","");Assert(g.RowCount==1,"missing row hidden");Assert(object.Equals(g.Rows[0].Cells[0].Value,true),"missing imported unchecked");
        g.Rows[0].Cells[0].Value=false;Assert(ModelDirectoryView.ChangedCount(g)==1,"virtual checkbox push not recorded");var cancelled=ModelDirectoryView.Changes(g).Cast<Dictionary<string,object>>().ToArray();Assert(cancelled.Length==1&&Json.Get(cancelled[0],"upstreamId")=="cn1"&&Json.Strings(cancelled[0],"importedRouteIds").SequenceEqual(new[]{"old-route"}),"missing route map");
        g.Rows[0].Cells[0].Value=true;Assert(object.Equals(g.Rows[0].Cells[0].Value,false),"missing row re-enabled");ModelDirectoryView.SelectVisible(g,true);Assert(object.Equals(g.Rows[0].Cells[0].Value,false),"bulk re-enabled missing row");
        Filter(g,"WorkBuddy 国内账号池","shared","");Assert(g.RowCount==1,"shared duplicate not merged");Assert(Convert.ToString(g.Rows[0].Cells[2].Value)=="Shared fresh","callable member not preferred");Assert(object.Equals(g.Rows[0].Cells[0].Value,true),"imported state lost across members");
        ModelDirectoryView.SelectVisible(g,false);cancelled=ModelDirectoryView.Changes(g).Cast<Dictionary<string,object>>().ToArray();Assert(cancelled.Length==2,"combined cancellation count");Assert(cancelled.Any(x=>Json.Get(x,"model")=="shared"&&Json.Get(x,"upstreamId")=="cn1"),"combined cancellation changed source");ModelDirectoryView.SelectVisible(g,true);Assert(ModelDirectoryView.ChangedCount(g)==1,"undo selection failed");
        Filter(g,"WorkBuddy 国内账号池","blocked","");ModelDirectoryView.SelectVisible(g,true);Assert(object.Equals(g.Rows[0].Cells[0].Value,false),"unavailable never-imported selected");
        Filter(g,"workbuddyai / ai","","");Assert(g.RowCount==1,"international filter lost");ModelDirectoryView.SelectVisible(g,true);Assert(ModelDirectoryView.Changes(g).Cast<Dictionary<string,object>>().Any(x=>Json.Get(x,"upstreamId")=="ai"&&object.Equals(x["enabled"],true)),"international import source changed");
        Filter(g,"","","");var onHeader=typeof(DataGridView).GetMethod("OnColumnHeaderMouseClick",BindingFlags.Instance|BindingFlags.NonPublic);onHeader.Invoke(g,new object[]{new DataGridViewCellMouseEventArgs(2,-1,0,0,new MouseEventArgs(MouseButtons.Left,1,0,0,0))});Assert(ModelDirectoryView.ChangedCount(g)==2,"sorting lost changes");
        Assert(Json.Text(catalog)==original,"input provider/model metadata mutated");var selectedCount=typeof(ModelDirectoryView).GetMethod("SelectedCount",BindingFlags.Static|BindingFlags.NonPublic);Assert(selectedCount!=null&&(int)selectedCount.Invoke(null,new object[]{g})==2,"selected count differs");
        Console.WriteLine("CATALOG_EDGES_PASS assertions="+assertions+" missing_cancel_only=true CN_AI_global_separate=true cross_upstream_routes=true sort_filter_preserves_dirty=true input_unchanged=true");
    }
    [STAThread]static int Main(string[] args){
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);int exit=0;
        using(var f=new Form{Width=1280,Height=800,ShowInTaskbar=false})using(var grid=ModelDirectoryView.Create())using(var platform=new ComboBox()){
            f.Controls.Add(grid);platform.Items.Add("全部平台");platform.SelectedIndex=0;
            f.Shown+=(s,e)=>f.BeginInvoke(new Action(()=>{try{
                int inputIndex=Array.IndexOf(args,"--input");var catalog=inputIndex>=0?Json.Object(File.ReadAllText(args[inputIndex+1],System.Text.Encoding.UTF8)):Catalog();var sw=Stopwatch.StartNew();int count=ModelDirectoryView.Populate(grid,catalog,platform);Application.DoEvents();sw.Stop();double populate=sw.Elapsed.TotalMilliseconds;
                int syncCalls=0;long scanTicks=0;grid.CellValueChanged+=(x,v)=>{var watch=Stopwatch.StartNew();ModelDirectoryView.ChangedCount(grid);watch.Stop();scanTicks+=watch.ElapsedTicks;syncCalls++;};
                sw.Restart();ModelDirectoryView.SelectVisible(grid,true);int dirty=ModelDirectoryView.ChangedCount(grid);sw.Stop();double select=sw.Elapsed.TotalMilliseconds;
                sw.Restart();for(int i=0;i<4;i++)Filter(grid,"",inputIndex>=0?"glm":"model-7","");Filter(grid,"","","");sw.Stop();double filter=sw.Elapsed.TotalMilliseconds;
                var changes=ModelDirectoryView.Changes(grid);Assert(dirty>0,"bulk change lost");Assert(changes.Count>0,"save empty");
                Console.WriteLine(Json.Text(new{models=count,rows=grid.Rows.Count,platformOptions=platform.Items.Count,populateMs=populate,selectMs=select,fiveFiltersMs=filter,syncCalls=syncCalls,changed=dirty,submitted=changes.Count,scanMs=(double)scanTicks/Stopwatch.Frequency*1000,virtualMode=grid.VirtualMode}));
                int captureIndex=Array.IndexOf(args,"--capture");if(captureIndex>=0){using(var bitmap=new Bitmap(f.Width,f.Height)){f.DrawToBitmap(bitmap,new Rectangle(Point.Empty,f.Size));bitmap.Save(args[captureIndex+1],System.Drawing.Imaging.ImageFormat.Png);}}
                if(args.Contains("--contract")){
                    Assert(count==500,"CN model duplicates retained: "+count);Assert(platform.Items.Count==4,"CN provider duplicates retained");Assert(grid.VirtualMode,"virtual data source absent");
                    ModelDirectoryView.SelectVisible(grid,false);Assert(ModelDirectoryView.Changes(grid).Count==48,"CN cancellation did not preserve 12 upstream route mappings");
                    Filter(grid,"","model-7","");Assert(VisibleCount(grid)==12,"search mismatch");ModelDirectoryView.SelectVisible(grid,true);int filteredDirty=ModelDirectoryView.ChangedCount(grid);Filter(grid,"","","");Assert(ModelDirectoryView.ChangedCount(grid)==filteredDirty,"filter lost selection");
                    Console.WriteLine("CATALOG_CONTRACT_PASS duplicate_pools=1 domestic_models=80 international_models=20 raw=1380 displayed=500 cancellation_targets=48");
                    EdgeCases(grid,platform);
                }
            }catch(Exception x){exit=1;Console.WriteLine("CATALOG_FIXTURE_FAIL "+x);}finally{f.Close();}}));Application.Run(f);
        }return exit;
    }
}
