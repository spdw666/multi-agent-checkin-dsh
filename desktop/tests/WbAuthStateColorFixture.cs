using System;
using System.IO;
using System.Linq;
using System.Drawing;
using System.Reflection;
using System.Collections.Generic;
using System.Windows.Forms;
using AiCreditDesktop;

internal static class WbAuthStateColorFixture {
    static int tests, failures;
    static readonly BindingFlags Fields = BindingFlags.Instance | BindingFlags.NonPublic;
    static void Check(bool ok, string name) {
        tests++; if (!ok) failures++;
        Console.WriteLine((ok ? "PASS " : "FAIL ") + name);
    }
    static Dictionary<string,object> Row(string credential = "authenticated") {
        return Json.Object(Json.Text(new {
            accountId = "SAMPLE-WB-ACCOUNT", label = "SAMPLE 登录状态示例", uid = "SAMPLE-UID", edition = "cn", enabled = true, inferenceEnabled = true,
            current = false, remaining = 2872, total = 3000, credentialStatus = credential,
            credential = new {status = credential, checkedAt = "2026-10-18T06:00:00Z"},
            ban = new {status = "unknown", source = "not_checked"},
            identity = new {uid = "SAMPLE-UID", userId = "SAMPLE-USER"},
            dailyCheckin = new {status = "unknown"}
        }));
    }
    static Label StateLabel(WbAccountCard card) { return (Label) typeof(WbAccountCard).GetField("state", Fields).GetValue(card); }
    static void ColorCase(string name, Dictionary<string,object> row, Color expected) {
        string original = Json.Text(row);
        using (var card = new WbAccountCard(row)) {
            var state = StateLabel(card);
            Check(state.ForeColor.ToArgb() == expected.ToArgb(), name);
            Check(state.Text == WbPoolUi.State(row) + " · " + (Json.Get(row,"edition","cn") == "cn" ? "国内版 CN" : "国际版 Global") + " · " + (Json.Enabled(row) ? "启用" : "停用") + " · " + WbPoolUi.DailyBadge(row), name + " header includes today check-in without altering authentication color");
            Check(Json.Text(row) == original, name + " does not mutate account");
        }
    }
    static double Channel(int value) { double n = value / 255d; return n <= .04045d ? n / 12.92d : Math.Pow((n+.055d)/1.055d,2.4d); }
    static double Luminance(Color color) { return .2126d*Channel(color.R)+.7152d*Channel(color.G)+.0722d*Channel(color.B); }
    static void Shot(string output, string name, Dictionary<string,object> row) {
        using (var form = new Form {Text = "SAMPLE WB status color", ClientSize = new Size(1180,650), BackColor = Theme.Background, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-15000,-15000), Font = Theme.Body})
        using (var card = new WbAccountCard(row)) {
            form.Controls.Add(card); card.Dock = DockStyle.Fill; form.Show(); form.PerformLayout(); Application.DoEvents();
            using(var image = new Bitmap(form.ClientSize.Width, form.ClientSize.Height)) {
                card.DrawToBitmap(image,new Rectangle(Point.Empty,form.ClientSize)); image.Save(Path.Combine(output,name));
            }
            form.Close();
        }
    }
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string output = args.Length == 0 ? Environment.CurrentDirectory : args[0]; Directory.CreateDirectory(output);
        try {
            ColorCase("authenticated stays accent", Row(), Theme.Accent);
            foreach(string status in new[]{"auth_rejected","expired","rejected","login_required","missing","banned"}) ColorCase(status + " is danger", Row(status), Theme.Danger);
            foreach(string status in new[]{"auth_rejected","missing","expired","banned"}) {
                var nested=Row(status); nested.Remove("credentialStatus"); ColorCase("nested " + status + " fallback is danger",nested,Theme.Danger);
            }
            var official=Row(); official["ban"]=new Dictionary<string,object>{{"status","banned"},{"source","official_response"}}; ColorCase("official ban remains danger",official,Theme.Danger);
            var manual=Row(); manual["ban"]=new Dictionary<string,object>{{"status","banned"},{"source","user_marked"}}; ColorCase("user marked ban remains danger",manual,Theme.Danger);
            var rejected=Row("not_checked"); rejected["ban"]=new Dictionary<string,object>{{"status","auth_rejected"},{"httpStatus",401}}; ColorCase("ban auth evidence is danger without ban conclusion",rejected,Theme.Danger);
            var disabled=Row(); disabled["enabled"]=false; ColorCase("account disabled does not imply login failure",disabled,Theme.Accent);
            var inference=Row(); inference["inferenceEnabled"]=false; ColorCase("inference disabled does not imply login failure",inference,Theme.Accent);
            var exhausted=Row(); exhausted["remaining"]=0; exhausted["usageStatus"]="exhausted"; ColorCase("credits exhausted does not imply login failure",exhausted,Theme.Accent);
            var network=Row("check_failed"); network["usageStatus"]="error"; network["error"]=new Dictionary<string,object>{{"code","provider_timeout"},{"httpStatus",504},{"authRejected",false}}; ColorCase("network check failure does not imply login failure",network,Theme.Accent);
            var dead=Row("check_failed"); dead["usageStatus"]="error"; dead["error"]=new Dictionary<string,object>{{"code","account_disabled"},{"message","Account missing or disabled"},{"status",400},{"httpStatus",400},{"banned",false},{"authRejected",false}}; ColorCase("disabled account probe failure is a login failure",dead,Theme.Danger);
            var denied=Row("check_failed"); denied["usageStatus"]="error"; denied["error"]=new Dictionary<string,object>{{"code","auth_rejected"},{"httpStatus",401},{"authRejected",true}}; ColorCase("rejected credential probe failure is a login failure",denied,Theme.Danger);
            var forbidden=Row("authenticated"); forbidden["usageStatus"]="error"; forbidden["error"]=new Dictionary<string,object>{{"code","forbidden"},{"httpStatus",403}}; ColorCase("forbidden probe failure is a login failure",forbidden,Theme.Danger);
            var serverDown=Row("check_failed"); serverDown["usageStatus"]="error"; serverDown["error"]=new Dictionary<string,object>{{"code","provider_network_error"},{"httpStatus",503},{"authRejected",false}}; ColorCase("upstream 503 probe failure keeps accent",serverDown,Theme.Accent);
            ColorCase("not checked stays accent",Row("not_checked"),Theme.Accent);
            var priority=Row(); priority["credential"]=new Dictionary<string,object>{{"status","auth_rejected"}}; ColorCase("current authenticated status wins old nested metadata",priority,Theme.Accent);
            using(var failure=new WbAccountCard(Row("auth_rejected"))) { Check(StateLabel(failure).ForeColor.ToArgb()==Theme.Danger.ToArgb(),"failed render is danger before recovery"); }
            using(var recovered=new WbAccountCard(Row())) { Check(StateLabel(recovered).ForeColor.ToArgb()==Theme.Accent.ToArgb(),"refreshed authenticated render recovers accent"); }
            Check(!WbPoolUi.IsBanned(Row("auth_rejected")),"auth rejection is not written as banned");
            Check(WbPoolUi.InferenceEnabled(Row("auth_rejected")),"auth rejection does not change inference switch");
            Check((Luminance(Theme.Surface)+.05d)/(Luminance(Theme.Danger)+.05d)>=4.5d,"existing danger text passes contrast on surface");
            Shot(output,"WB_AUTH_FAILED.SAMPLE.png",Row("auth_rejected"));
            Shot(output,"WB_AUTH_RECOVERED.SAMPLE.png",Row());
            Console.WriteLine("WB_AUTH_STATE_COLOR tests="+tests+" failures="+failures+" synthetic=true realNetworkCalls=0");
            File.WriteAllText(Path.Combine(output,"RESULT.json"),Json.Text(new{tests=tests,failures=failures,synthetic=true,realNetworkCalls=0}));
            return failures==0?0:1;
        } catch(Exception e) { Console.Error.WriteLine(e); return 2; }
    }
}
