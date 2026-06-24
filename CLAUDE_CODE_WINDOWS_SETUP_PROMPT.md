# Claude Code Windows Setup Prompt

Copy this prompt into Claude Code on Bilal's Windows computer.

```text
You are helping me set up a local video generation app on Windows. I am new to coding, so please guide me step by step and keep everything simple.

GitHub repo:
<paste the GitHub repo link here>

Goal:
- Download/install the app on this Windows computer.
- Run it locally at http://localhost:3000.
- Make it start automatically every time Windows starts.
- Help me bookmark the app in my browser so I can find it easily.

Please do this end to end:

1. Check whether Git is installed.
   - If Git is installed, clone the repo into C:\Apps\bilal-demo-video-generation.
   - If Git is not installed, either help me install Git from the official website or download the repo ZIP from GitHub and extract it into C:\Apps\bilal-demo-video-generation.

2. Check whether Node.js 20 or newer is installed.
   - Run node -v.
   - If Node.js is missing or too old, help me install the current Node.js LTS version from https://nodejs.org.
   - After installation, reopen the terminal if needed and confirm node -v works.

3. Open the app folder in the terminal:
   C:\Apps\bilal-demo-video-generation

4. Install the app:
   npm install

5. Launch the app:
   npm run dev

6. Open the app in the browser:
   http://localhost:3000

7. Help me configure the app:
   - Open Settings in the app.
   - Help me paste my required API keys:
     - LABS69_API_KEY
     - GOOGLE_API_KEY
   - Do not commit, upload, or share my API keys.
   - If the app asks for optional Anthropic/OpenAI keys, explain they are optional fallbacks.

8. Confirm the app works:
   - The dashboard opens.
   - I can open Settings.
   - I can open Channels.
   - I can open Video.
   - Do not run a paid video generation test unless I explicitly approve it.

9. Add a browser bookmark:
   - Bookmark name: Bilal Demo Video
   - Bookmark URL: http://localhost:3000
   - Put it somewhere easy to find, like the bookmarks bar.

10. Set up automatic startup on Windows:
   - Ask me before making the system change.
   - Prefer Windows Task Scheduler.
   - Create a task that starts when I log in to Windows.
   - The task should run the app from:
     C:\Apps\bilal-demo-video-generation
   - It should start the app with:
     npm run dev
   - Make sure it runs in the correct folder.
   - After creating it, restart or log out/in only if I approve, then confirm the app starts again.

11. At the end, give me a tiny cheat sheet:
   - App link: http://localhost:3000
   - App folder: C:\Apps\bilal-demo-video-generation
   - Start manually: double-click start.bat or run npm run dev in the app folder
   - Stop manually: close the terminal window running the app
   - Update app later: open the app folder and run git pull, then npm install
   - Update API keys later: open the app, go to Settings

Please do not explain unnecessary technical details. If something fails, tell me the exact simple fix and then continue.
```
