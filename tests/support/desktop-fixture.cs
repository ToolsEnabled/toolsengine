// Owned acceptance windows; no files, credentials, network or shell controls.
using System;
using System.Windows.Forms;

public static class DesktopFixture {
  [STAThread]
  public static void Main(string[] args) {
    if (args.Length != 2) return;
    Application.EnableVisualStyles();
    var form = new Form { Text = args[0], Width = 600, Height = 400 };
    var field = new TextBox {
      Multiline = true, Dock = DockStyle.Fill, Text = args[1],
      AccessibleName = "Probe text"
    };
    field.TextChanged += (sender, e) => { form.Text = "*" + args[0]; };
    form.Controls.Add(field);
    Application.Run(form);
  }
}
