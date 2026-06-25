; NSIS installer hooks for StarDust.
;
; Tauri вызывает эти макросы на соответствующих этапах работы
; установщика/деинсталлятора. Здесь мы при удалении программы
; предлагаем также стереть данные лаунчера (Java, клиент Minecraft,
; NeoForge, ассеты, настройки и сессию) из %APPDATA%.
;
; Идентификатор приложения берётся из `identifier` в tauri.conf.json:
;   com.project.launcher  ->  %APPDATA%\com.project.launcher

!macro NSIS_HOOK_POSTUNINSTALL
  ; Спрашиваем пользователя: по умолчанию (кнопка No) данные сохраняются,
  ; чтобы случайно не потерять миры/настройки. Yes — полное удаление.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Удалить также все данные лаунчера?$\r$\n$\r$\nБудут стёрты: Java, клиент Minecraft, NeoForge, ассеты, моды, настройки и данные входа.$\r$\n$\r$\nНажмите «Нет», чтобы сохранить их для будущей переустановки." \
    /SD IDNO IDYES delete_appdata IDNO keep_appdata

  delete_appdata:
    RMDir /r "$APPDATA\com.project.launcher"
    Goto appdata_done

  keep_appdata:
  appdata_done:
!macroend
