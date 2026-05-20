// Glance preferences — minimal GtkBuilder-free UI: int spin buttons + a
// file chooser for backend-path.

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/prefs.js";

export default class GlancePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({ title: "General", icon_name: "preferences-system-symbolic" });
        window.add(page);

        const backendGroup = new Adw.PreferencesGroup({ title: "Backend" });
        page.add(backendGroup);

        backendGroup.add(makeSpin(settings, "backend-port",      "HTTP port",         1024, 65535, 1));
        backendGroup.add(makeSpin(settings, "refresh-interval",  "Refresh (seconds)", 5,    600,   1));
        backendGroup.add(makeSwitch(settings, "auto-start-backend", "Auto-start backend",
            "If on, the extension spawns the Node.js backend on enable and stops it on disable."));
        backendGroup.add(makePathRow(settings, "backend-path", "Path to server.js"));

        const uiGroup = new Adw.PreferencesGroup({ title: "Appearance" });
        page.add(uiGroup);
        uiGroup.add(makeSpin(settings, "dropdown-width-pct", "Dropdown width (% of monitor)", 30, 100, 5));
    }
}

function makeSpin(settings, key, title, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
    });
    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makeSwitch(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makePathRow(settings, key, title) {
    const row = new Adw.EntryRow({ title });
    settings.bind(key, row, "text", Gio.SettingsBindFlags.DEFAULT);
    return row;
}
