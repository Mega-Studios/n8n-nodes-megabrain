# n8n.io template submissions

Texts for the n8n creator portal (creators.n8n.io). Each template's JSON is in this folder; the sticky note inside the workflow repeats the setup steps.

---

## 1. Telegram AI image bot with Nano Banana Pro (MegaBrain)

File: `telegram-image-bot-nano-banana-pro.json` · Categories: AI, Marketing

Turn any Telegram message into a 2K image made by Google's Nano Banana Pro.

### How it works
1. **Telegram Trigger** receives a message.
2. The bot shows "sending photo…" while it works.
3. **HTTP Request** calls the MegaBrain API (`POST /images/generations`, model `nano-banana-pro`, 2K, JPEG).
4. If the image takes longer than ~110 seconds, the API answers 202 and the workflow polls the job until it is ready.
5. **Telegram** sends the photo back. If generation fails, the user gets a message with the reason (failed jobs are refunded).

### Set up (2 minutes)
1. Get an API key at https://getmegabrain.com/keys and add funds (pay as you go, $0.17 per image).
2. Create a **Header Auth** credential named `MegaBrain API key`: name `Authorization`, value `Bearer YOUR_KEY`.
3. Create a **Telegram** credential with your bot token from @BotFather.
4. Activate the workflow and message your bot.

### Customize
Change `aspect_ratio` / `resolution` in the request body, or swap the model for `flux-2`, `nano-banana-2` or `bytedance/seedream/v4.5/text-to-image` (list: https://getmegabrain.com/docs/media).

---

## 2. Generate AI videos with Kling 3 from a form (MegaBrain)

File: `text-to-video-kling-3.json` · Categories: AI, Marketing

Type a one-line idea, get a Kling 3 video in 1–3 minutes.

### How it works
1. **Form Trigger** asks for the idea, length (3/5/10 s) and sound.
2. A free text model (`mb-auto/free`) rewrites the idea into a cinematic prompt.
3. **HTTP Request** submits the job to the MegaBrain queue (`kling-video/v3/standard/text-to-video`).
4. A **Wait → status → Switch** loop polls every 15 seconds until the job is `COMPLETED` (a `FAILED` job is refunded and stops the run).
5. A **Form Ending** page shows the video with a player and a link.

### Set up
1. API key at https://getmegabrain.com/keys ($0.097 per second of video without sound).
2. **Header Auth** credential `MegaBrain API key`: `Authorization` = `Bearer YOUR_KEY`.
3. Open the form URL and submit an idea.

### Customize
Add a YouTube, TikTok or Google Drive node after **Video link** to publish the clip automatically, or switch to `kling-video/v3/pro/text-to-video` / `bytedance/seedance-2.5/text-to-video`.

---

## 3. Instagram carousel images and caption with FLUX 2 (MegaBrain)

File: `instagram-carousel-flux-2.json` · Categories: AI, Marketing

Plan, draw and caption an Instagram carousel from one topic.

### How it works
1. **Topic** sets the subject, number of slides and visual style.
2. A free text model (`mb-auto/free`) returns JSON: a caption with hashtags and one image prompt per slide.
3. **Loop Over Items** draws the slides one by one with **FLUX 2** at 1080×1350 (4:5) through the MegaBrain API.
4. **Carousel** returns the caption and the slide URLs, ready for Instagram, a scheduler or Google Drive.

### Set up
1. API key at https://getmegabrain.com/keys (FLUX 2 is $0.014 per megapixel: about $0.14 for 5 slides).
2. **Header Auth** credential `MegaBrain API key`: `Authorization` = `Bearer YOUR_KEY`.
3. Edit **Topic** and run the workflow.

---

## 4. Product photo to video ad with Nano Banana Pro and Kling 3 (MegaBrain)

File: `product-photo-to-video-ad.json` · Categories: AI, Marketing

A UGC-style video ad from one product photo.

### How it works
1. **Form Trigger** takes a public product photo URL, the product and the audience.
2. A free text model writes the scene: a lifestyle shot and a 5-second action.
3. **Nano Banana Pro Edit** places the product into the scene and keeps its label.
4. **Kling 3 image-to-video** animates the shot into a vertical clip; a Wait/Switch loop polls the job.
5. A **Form Ending** page shows the video and the image.

### Set up
1. API key at https://getmegabrain.com/keys (about $0.17 for the image + $0.48 for 5 s of video).
2. **Header Auth** credential `MegaBrain API key`: `Authorization` = `Bearer YOUR_KEY`.
3. Open the form and paste a product photo link.

---

## 5. AI agent on 100+ models with one key (MegaBrain, OpenAI-compatible)

File: `ai-agent-any-model.json` · Categories: AI

Run n8n's AI Agent on Claude, GPT, Gemini, Kimi, GLM, Qwen, DeepSeek and more with one API key — or for free.

### How it works
The **OpenAI Chat Model** node points at MegaBrain's OpenAI-compatible API, so the agent can use any of 100+ models. It starts on `mb-auto/free`, a free model that needs no balance.

### Set up
1. Get a key at https://getmegabrain.com/keys.
2. Create an **OpenAI** credential: API Key = your MegaBrain key, Base URL = `https://getmegabrain.com/api/gateway/v1`.
3. Open the chat and talk. Pick another model in **MegaBrain model** (the list loads from the API). All models: https://getmegabrain.com/models
