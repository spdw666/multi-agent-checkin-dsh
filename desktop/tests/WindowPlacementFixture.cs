using System;using System.Drawing;using System.Reflection;using System.Windows.Forms;using AiCreditDesktop;
internal static class WindowPlacementFixture {
 static int tests,failures;
 static readonly MethodInfo recover=typeof(MainWindow).GetMethod("RecoverWindowBounds",BindingFlags.NonPublic|BindingFlags.Static);
 static Rectangle Apply(Rectangle value,Rectangle[] areas,Rectangle preferred){return recover==null?value:(Rectangle)recover.Invoke(null,new object[]{value,areas,preferred});}
 static void Check(bool ok,string name){tests++;if(!ok)failures++;Console.WriteLine((ok?"PASS ":"FAIL ")+name);}
 [STAThread]static int Main(){
  var main=new Rectangle(0,0,1707,1019);var left=new Rectangle(-1920,0,1920,1040);var screens=new[]{main,left};
  var sentinel=new Rectangle(-32000,-32000,780,700);var a=Apply(sentinel,new[]{main},main);Check(main.Contains(a),"minimized sentinel is recovered fully inside current work area");Check(a.Width==1320&&a.Height==900,"offscreen corrupted minimum-size window recovers useful default size");Check(a.X==193&&a.Y==59,"recovery centers the window rather than preserving -32000");
  var valid=new Rectangle(40,45,1320,900);Check(Apply(valid,screens,main)==valid,"normal valid placement remains unchanged");
  var secondary=new Rectangle(-1800,60,1300,900);Check(Apply(secondary,screens,main)==secondary,"real negative-coordinate monitor placement is preserved");
  Check(main.Contains(Apply(new Rectangle(4000,200,1320,900),new[]{main},main)),"disconnected right-hand monitor returns to current monitor");
  Check(main.Contains(Apply(new Rectangle(100,-2000,1320,900),new[]{main},main)),"disconnected upper monitor returns to current monitor");
  Check(main.Contains(Apply(new Rectangle(1600,900,1320,900),new[]{main},main)),"partially offscreen window is clamped including title bar");
  var small=new Rectangle(0,0,1024,728);Check(small.Contains(Apply(new Rectangle(0,0,2560,1600),new[]{small},small)),"DPI or resolution shrink fits current work area");
  var tiny=Apply(new Rectangle(0,0,346,39),new[]{main},main);Check(tiny.Width>=780&&tiny.Height>=700,"minimized caption dimensions cannot become normal window dimensions");
  Check(main.Contains(Apply(Rectangle.Empty,new[]{main},main)),"empty saved placement receives a usable window");
  Check(main.Contains(Apply(sentinel,new Rectangle[0],main)),"no enumerated monitor uses valid primary fallback");
  Check(left.Contains(Apply(new Rectangle(-2500,80,1300,900),screens,main)),"largest actual overlap selects the correct negative monitor");
  Check(typeof(MainWindow).GetMethod("RestoreVisibleWindow",BindingFlags.NonPublic|BindingFlags.Instance)!=null,"real restore path exposes on-screen recovery before refresh");
  Console.WriteLine("WINDOW_PLACEMENT tests="+tests+" failures="+failures+" exit="+(failures==0?0:1));return failures==0?0:1;
 }
}
