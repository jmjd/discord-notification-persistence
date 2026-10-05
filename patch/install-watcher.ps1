# Starts the update watcher at logon, so a Discord update never leaves the patch reverted.
#
# Install:    powershell -ExecutionPolicy Bypass -File install-watcher.ps1
# Uninstall:  powershell -ExecutionPolicy Bypass -File install-watcher.ps1 -Uninstall
#
# Prefers a scheduled task (auto-restarts if it dies, runs even after a missed logon), but
# an at-logon task needs administrator rights. Without them it falls back to a shortcut in
# your Startup folder, which needs no elevation and does the same job -- it just will not
# restart the watcher if it ever crashes.
#
# The watcher runs resident (~40 MB) and re-applies the patch as soon as a Discord update
# stages a new app-<version> folder, before Discord restarts into it.

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here 'launch-watcher.vbs'
$taskName = 'DiscordNotificationFixWatcher'
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startupDir 'Discord Notification Fix Watcher.lnk'

if ($Uninstall) {
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        Write-Host "Removed scheduled task '$taskName'."
    }
    catch { Write-Host "No scheduled task to remove." }
    if (Test-Path $shortcut) {
        Remove-Item $shortcut -Force
        Write-Host "Removed Startup shortcut."
    }
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like '*watch.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped watcher pid $($_.ProcessId)." }
    Write-Host "Done. The patch itself stays applied; run 'node patch.js revert' to undo that."
    return
}

if (-not (Test-Path $vbs)) { throw "launch-watcher.vbs not found next to this script" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node.exe not found on PATH" }

$installed = $false
try {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $here
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    # ExecutionTimeLimit of zero means "no limit" -- required, since this task stays resident.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -Description 'Watches for Discord updates and re-applies the notification-center persistence patch before Discord restarts into the new build.' `
        -Force -ErrorAction Stop | Out-Null
    Write-Host "Registered scheduled task '$taskName' (starts at logon)."
    $installed = $true
}
catch {
    Write-Host "Scheduled task needs administrator rights ($($_.Exception.Message.Trim()))."
    Write-Host "Falling back to a Startup shortcut, which does not."
}

if (-not $installed) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($shortcut)
    $lnk.TargetPath = 'wscript.exe'
    $lnk.Arguments = "`"$vbs`""
    $lnk.WorkingDirectory = $here
    $lnk.WindowStyle = 7          # minimised; the .vbs itself starts node with no window
    $lnk.Description = 'Re-applies the Discord notification-center patch after Discord updates'
    $lnk.Save()
    Write-Host "Created Startup shortcut: $shortcut"
    Write-Host "(Visible in Task Manager > Startup apps, and removable from there or that folder.)"
}

Write-Host ""
Write-Host "Activity is logged to $here\watch.log"
