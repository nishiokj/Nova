---
session: tui_1770358129978_805rks
created: 2026-02-06T06:08:49.979Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770358175858
 Make the control dashboard have a Markdown editor / viewer as the first class item. The screen should load without a a session selected with a blank Markdown file directly in the browser with the cursor blinking there. Make the input bar appear with "Ctrl+`" like on VSCode. Have the suggested text while in Markdown mode be "Chat about Document". You should still be able to access the other left and right panels with 1 and 3. Move the "Done" Sessions to the right Side. Then, put the Directory for your markdown files. Add ability to create folders and create files both through buttons and through keyboard only, whichever is a common keybind for that. For new file creation we should probably auto-suggest a few folders to place the new markdown file in. We also should support splitting the Markdown editor once vertically. Make the markdown editor silky, optimized nice feeling. It's the main character. We'll need some plumbing on the API system. We should have the endpoint to receive a markdown file but we also want to be able to send markdown files. Some of the use cases will be Chat + markdown edits. So like you can be talking back and forth with the agent, and it wil edit the markdown file as well as send messages. Perhaps we need to support Patches to our markdown files, or the solution would just be to send a new one every time and overwrite on our side, otherwise it may be hard to not have race conditions? or we keep version numbers and version the patches.e also want to be able to send markdown files. Some of the use cases will be Chat + markdown edits. So like you can be talking back and forth with the agent, and it wil edit the markdown file as well as send messages. Perhaps we need to support Patches to our markdown files, or the solution would just be to send a new one every time and overwrite on our side, otherwise it may be hard to not have race conditions? or we keep version numbers and version the patches.
