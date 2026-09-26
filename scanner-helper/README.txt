Scanner helper for Teacher Training Assessments
===============================================

This lets the Scan buttons in the app take pages straight from the scanner
plugged into this laptop (the Fujitsu SP-1130N, through its PaperStream IP
driver). It only works while its window is open.

To start it
  1. Double-click "Start scanner helper".
     The first time, it downloads a private copy of Python (the official 32-bit
     build, about 13 MB) into your user folder. That takes a minute.
  2. Leave the window open. It says "Listening on http://127.0.0.1:17645".
  3. In the app, open Assessments and press "Connect scanner" once. Your
     browser may ask whether the site can reach apps on this device: choose
     Allow.
  4. Put the pages in the scanner's feeder and press Scan on the teacher's row.

Close the window to stop it.

Good to know
  - Every scan is also kept as JPEG files in Documents\Assessment scans, in a
    folder for each day, so nothing is lost if an upload fails.
  - Close PaperStream Capture while you scan from the app. Only one program can
    use the scanner at a time.
  - "Both sides" in the app scans both sides of each sheet and leaves out blank
    backs.
  - The helper only answers the Teacher Training Assessments app, and only on
    this computer.

Settings (optional)
  Start it from a command prompt in this folder with any of these after it:
    "Start scanner helper" --dpi 300          sharper scans (the default is 200)
    "Start scanner helper" --color gray       grey instead of colour (or bw)
    "Start scanner helper" --folder "D:\Scans"   keep the copies somewhere else

If Windows won't run "Start scanner helper"
  Right-click the zip you downloaded, choose Properties, tick Unblock, press OK,
  then extract it again and use the new folder.
