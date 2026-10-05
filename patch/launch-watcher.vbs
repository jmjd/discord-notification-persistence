' Starts watch.js with no console window. Task Scheduler runs node.exe in your session,
' which would otherwise leave a visible console window sitting on the desktop.
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
' 0 = hidden window, False = do not wait for it to exit
shell.Run "node.exe """ & here & "\watch.js""", 0, False
