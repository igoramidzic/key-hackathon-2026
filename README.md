# Hackathon 2026

Project explorations using Google AI models and GCP.

Read the [product and architecture proposal](docs/computer-use-proposal.md) for the recommended model and stack, architecture diagram, permission requirements, demo scope, and product worksheet.

Read the [voice to text proposal](docs/voice-to-text-proposal.md) for faster dictation with Gemini cleanup, a GCP architecture, an optional screen-context follow-up, demo scope, and product worksheet.

## Voice to text demo

Open [demos/voice-to-text/index.html](demos/voice-to-text/index.html) directly in any modern desktop browser. The entire demo is in this one file: no installation, server, network connection, or microphone access is needed. Copy or email the HTML file to run it on another computer.

Choose an example, click the microphone button, read the phrase aloud, and click it again to reveal the scripted plain and cleaned-up text. You can also press **Space** to start or stop when focus is outside a button, and **Escape** to reset. Both outputs are prewritten illustrations, not actual Apple Dictation or Gemini results.

## Computer use demo

Open [demos/computer-use/index.html](demos/computer-use/index.html) directly in any modern desktop browser. Like the voice demo, it is a single file that needs no installation, server, or network connection.

The demo plays on its own and loops. A browser window on the left shows a mock service desk app. The assistant panel on the right shows the assistant's reasoning, each action it takes, and the moments when it asks the user for help or approval. In the scripted run, it opens a catalog task, finds the missing details, ignores an instruction hidden in a ticket comment, asks the user for a team and an address, fills in the form, waits for approval, saves, and checks the result. Use **Pause**, **Restart**, and **1×/2×** to control playback, or press **Space** to pause and **R** to restart. The app, records, and assistant output are all made up; no model is called.
