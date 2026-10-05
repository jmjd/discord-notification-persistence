# Control experiment: posts a toast to Windows directly under Discord's identity, bypassing
# Discord entirely. This separates "Windows is dropping Discord's notifications" from
# "Discord never sent one".
#
#   powershell.exe -ExecutionPolicy Bypass -File test-toast.ps1
#   powershell.exe -ExecutionPolicy Bypass -File test-toast.ps1 -Hide
#
# Must run under Windows PowerShell (powershell.exe), not pwsh 7 -- PowerShell 7 dropped the
# WinRT type projection this uses.
#
# Default: shows a toast that nothing ever closes. If it appears AND stays in the
# notification center, Windows and Discord's app registration are both healthy.
#
# -Hide: shows the toast, waits 8s, then calls ToastNotifier.Hide() on it -- the exact call
# Electron's notification.close() makes. Watch the notification center: the entry vanishing
# is the bug being reproduced from first principles.

param([switch]$Hide)

$ErrorActionPreference = 'Stop'
$aumid = 'com.squirrel.Discord.Discord'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

$stamp = Get-Date -Format 'HH:mm:ss'
$line2 = if ($Hide) { "Will be hidden in 8s - watch it disappear from the center" }
         else { "This one should STAY in the notification center" }

# Same shape Discord builds in notifications_win.js: ToastGeneric, two text lines.
$xmlText = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>Claude Code test toast $stamp</text>
      <text>$line2</text>
    </binding>
  </visual>
  <audio silent="true" />
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)
$notifier.Show($toast)

Write-Host "Posted a test toast as '$aumid'."

if ($Hide) {
    Write-Host "Waiting 8s, then calling Hide() -- the same call Electron's close() makes..."
    Start-Sleep -Seconds 8
    $notifier.Hide($toast)
    Write-Host "Hide() called. Check the notification center: the entry should now be gone."
    Write-Host "That is exactly what Discord does to its own notifications."
}
else {
    Write-Host "Check now: did a banner appear, and is it still listed in the notification center?"
    Write-Host "  banner + stays listed  -> Windows is fine; Discord simply never sent one"
    Write-Host "  no banner at all       -> Windows-side suppression (Do Not Disturb / focus / per-app)"
}
