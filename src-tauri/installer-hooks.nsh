; WorshipFluent installer hook (Tauri NSIS template).
; The installer was downloaded as WorshipFluent-Setup-<CODE>.exe: the code pairs this
; computer to the church. The app can't see the installer's name once installed, so
; this writes the code where the app looks on first launch (next to the executable).
!macro NSIS_HOOK_POSTINSTALL
  Push $EXEFILE
  Call ExtractPairCode
  Pop $0
  ${If} $0 != ""
    FileOpen $1 "$INSTDIR\pairing-code.txt" w
    FileWrite $1 "$0"
    FileClose $1
  ${EndIf}
!macroend

; Sets $0 to the code found in the installer file name, or "" when there is none.
Function ExtractPairCode
  Exch $R0            ; file name
  Push $R1
  Push $R2
  StrCpy $0 ""
  ; find "Setup-" and take what follows up to "." or " "
  StrLen $R1 $R0
  StrCpy $R2 0
  loop:
    IntCmp $R2 $R1 done
    StrCpy $1 $R0 6 $R2
    StrCmp $1 "Setup-" found
    IntOp $R2 $R2 + 1
    Goto loop
  found:
    IntOp $R2 $R2 + 6
    StrCpy $R0 $R0 "" $R2
    StrCpy $0 ""
  take:
    StrCpy $1 $R0 1
    StrCmp $1 "" done
    StrCmp $1 "." done
    StrCmp $1 " " done
    StrCpy $0 "$0$1"
    StrCpy $R0 $R0 "" 1
    Goto take
  done:
  Pop $R2
  Pop $R1
  Pop $R0
  Push $0
FunctionEnd
