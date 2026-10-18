using System;using System.Collections.Generic;using System.Drawing;using System.Linq;using System.Reflection;using System.Windows.Forms;using AiCreditDesktop;
// Regression fixture for the range buttons and the empty-data paint path.
// The red cross in the field came from Json.Get(data,"range") on a null payload.
internal static class ActivityRangeFixture {
 static int tests,failures;
 static readonly BindingFlags F=BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic;
 static void Check(bool ok,string name){tests++;if(!ok)failures++;Console.WriteLine((ok?"PASS ":"FAIL ")+name);}
 static object Field(object o,string n){return o.GetType().GetField(n,F).GetValue(o);}
 static IEnumerable<Control> All(Control c){foreach(Control x in c.Controls){yield return x;foreach(var y in All(x))yield return y;}}
 static Bitmap Paint(Control c){var b=new Bitmap(Math.Max(8,c.Width),Math.Max(8,c.Height));using(var g=Graphics.FromImage(b)){var m=c.GetType().GetMethod("OnPaint",F);m.Invoke(c,new object[]{new PaintEventArgs(g,new Rectangle(0,0,c.Width,c.Height))});}return b;}
 [STAThread] static int Main(){
  Application.SetCompatibleTextRenderingDefault(false);
  try{
   var chartType=typeof(ActivityBoard).Assembly.GetType("AiCreditDesktop.ActivityChart",true);
   var chart=(Control)Activator.CreateInstance(chartType,true);
   chart.Size=new Size(520,240);
   // 1. paint before any bind: this is the exact field crash
   var threw=false;
   try{ using(var bmp=Paint(chart)){} }catch(Exception e){threw=true;Console.WriteLine("PAINT_ERROR "+e.GetBaseException().Message);}
   Check(!threw,"empty chart paints without throwing");
   var summary=(string)chartType.GetMethod("Summary",F).Invoke(chart,null);
   Check(summary.Contains("近 7 日"),"empty chart summary falls back to 7 days");

   // 2. bind a 30-day payload and confirm the label/bucket switch
   var payload=new Dictionary<string,object>{
     {"range","30d"},{"bucketDays",30},
     {"daily",Enumerable.Range(0,30).Select(i=>new Dictionary<string,object>{{"date","2026-10-"+(i<9?"0"+(i+1):(i+1).ToString())},{"requests",i}}).ToList()}
   };
   chartType.GetMethod("Bind",F).Invoke(chart,new object[]{payload});
   var painted=false;
   try{ using(var bmp=Paint(chart)){painted=true;} }catch(Exception e){Console.WriteLine("PAINT30_ERROR "+e.GetBaseException().Message);}
   Check(painted,"30-day chart paints");
   var s30=(string)chartType.GetMethod("Summary",F).Invoke(chart,null);
   Check(s30.Contains("近 30 天"),"30-day summary says 近 30 天");
   Check((int)chartType.GetMethod("BucketDays",F).Invoke(chart,null)==30,"bucket days read from payload");

   // 3. all-range payload keeps the 30-bar chart but says so
   payload["range"]="all";
   chartType.GetMethod("Bind",F).Invoke(chart,new object[]{payload});
   var sAll=(string)chartType.GetMethod("Summary",F).Invoke(chart,null);
   Check(sAll.Contains("累计全部"),"all summary says 累计全部");
   Check(sAll.Contains("仅近 30 天"),"all summary discloses the 30-day chart limit");
  }catch(Exception e){failures++;Console.WriteLine("FIXTURE_ERROR "+e);}
  Console.WriteLine("ACTIVITY_RANGE_NATIVE tests="+tests+" failures="+failures);
  return failures==0?0:1;
 }
}
