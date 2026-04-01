# Windows Build Environment

Node.js: C:\Program Files\nodejs\npm.cmd
Android SDK: D:\Android\sdk
Android NDK: D:\Android\sdk\ndk\30.0.14904198
Java Home: C:\Program Files\Android\Android Studio\jbr
Project path: E:\OneDrive\Team Nocturnal\Projects\Nocturnal Toolkit

## Windows Build Commands

### Desktop (Windows NSIS):
powershell.exe -ExecutionPolicy Bypass -Command "$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; Set-Location 'E:\OneDrive\Team Nocturnal\Projects\Nocturnal Toolkit'; & 'C:\Program Files\nodejs\npm.cmd' run tauri build"

### Android APK:
powershell.exe -ExecutionPolicy Bypass -Command "$env:ANDROID_HOME = 'D:\Android\sdk'; $env:ANDROID_SDK_ROOT = 'D:\Android\sdk'; $env:NDK_HOME = 'D:\Android\sdk\ndk\30.0.14904198'; $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'; $env:PATH = $env:PATH + ';D:\Android\sdk\platform-tools;D:\Android\sdk\cmdline-tools\latest\bin;C:\Program Files\nodejs'; Set-Location 'E:\OneDrive\Team Nocturnal\Projects\Nocturnal Toolkit'; & 'C:\Program Files\nodejs\npm.cmd' run tauri android build"

### Both in sequence:
Run Desktop first, then Android.
