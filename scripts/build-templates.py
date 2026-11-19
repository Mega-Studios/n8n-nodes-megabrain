"""Builds the n8n workflow templates for MegaBrain (HTTP Request based)."""

import json
import sys
import uuid
from pathlib import Path

OUT = Path(sys.argv[1])
BASE = "https://getmegabrain.com/api/gateway/v1"
CRED = {"httpHeaderAuth": {"id": "mbHeaderAuth0001", "name": "MegaBrain API key"}}
FREE_MODEL = "mb-auto/free"


def uid(name: str, wf: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"megabrain-n8n/{wf}/{name}"))


class WF:
    def __init__(self, slug: str, name: str):
        self.slug = slug
        self.name = name
        self.nodes = []
        self.connections = {}

    def add(self, name, type_, version, pos, params, **extra):
        node = {
            "parameters": params,
            "id": uid(name, self.slug),
            "name": name,
            "type": type_,
            "typeVersion": version,
            "position": list(pos),
        }
        # Published templates carry no credential ids or names (n8n.io submission
        # guidelines): the setup note says which credential each node needs.
        extra.pop("credentials", None)
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, src, dst, out=0, kind="main", inp=0):
        conns = self.connections.setdefault(src, {}).setdefault(kind, [])
        while len(conns) <= out:
            conns.append([])
        conns[out].append({"node": dst, "type": kind, "index": inp})

    def note(self, name, pos, content, width=380, height=300, color=None):
        params = {"content": content, "height": height, "width": width}
        if color:
            params["color"] = color
        self.add(name, "n8n-nodes-base.stickyNote", 1, pos, params)

    def write(self, description):
        data = {
            "name": self.name,
            "nodes": self.nodes,
            "connections": self.connections,
            "pinData": {},
            "settings": {"executionOrder": "v1"},
            "meta": {"templateCredsSetupCompleted": False},
            "tags": [],
        }
        (OUT / f"{self.slug}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        return {"file": f"{self.slug}.json", "name": self.name, "description": description}


# ----------------------------------------------------------------------------- helpers


def http_post(path, body_expr, timeout=120000, auth=True, **extra):
    params = {
        "method": "POST",
        "url": f"{BASE}{path}",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": body_expr,
        "options": {"timeout": timeout},
    }
    if auth:
        params = {
            **params,
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
        }
    return params


def http_get(url_expr, timeout=60000):
    return {
        "url": url_expr,
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "options": {"timeout": timeout},
    }


def condition(left, right, op="equals"):
    return {
        "leftValue": left,
        "rightValue": right,
        "operator": {"type": "string", "operation": op},
    }


def switch_rules(rules):
    """rules: list of (output name, left expr, right value)."""
    values = []
    for key, left, right in rules:
        values.append(
            {
                "conditions": {
                    "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                    "conditions": [condition(left, right)],
                    "combinator": "and",
                },
                "renameOutput": True,
                "outputKey": key,
            }
        )
    return {"rules": {"values": values}, "options": {"fallbackOutput": "extra", "renameFallbackOutput": "Running"}}


def add_poll_loop(wf, submit, x, y, label, wait_seconds, on_done):
    """Wait → status → switch (Completed / Failed / Running→Wait) → result."""
    wait = wf.add(
        f"Wait {wait_seconds}s",
        "n8n-nodes-base.wait",
        1.1,
        (x, y),
        {"amount": wait_seconds},
        webhookId=uid(f"wait-{label}", wf.slug),
    )
    status = wf.add(
        f"Get {label} status",
        "n8n-nodes-base.httpRequest",
        4.2,
        (x + 220, y),
        http_get(f"={{{{ $('{submit}').item.json.status_url }}}}"),
        credentials=CRED,
    )
    switch = wf.add(
        "Done yet?",
        "n8n-nodes-base.switch",
        3.2,
        (x + 440, y),
        switch_rules(
            [
                ("Completed", "={{ $json.status }}", "COMPLETED"),
                ("Failed", "={{ $json.status }}", "FAILED"),
            ]
        ),
    )
    result = wf.add(
        f"Get {label}",
        "n8n-nodes-base.httpRequest",
        4.2,
        (x + 700, y - 120),
        http_get(f"={{{{ $('{submit}').item.json.response_url }}}}"),
        credentials=CRED,
    )
    failed = wf.add(
        "Job failed (refunded)",
        "n8n-nodes-base.stopAndError",
        1,
        (x + 700, y + 60),
        {
            "errorMessage": f"=The {label} job failed. MegaBrain returned the price to your balance. Request: {{{{ $('{submit}').item.json.request_id }}}}"
        },
    )
    wf.link(submit, wait)
    wf.link(wait, status)
    wf.link(status, switch)
    wf.link(switch, result, out=0)
    wf.link(switch, failed, out=1)
    wf.link(switch, wait, out=2)
    wf.link(result, on_done)
    return result


IMAGE_URL_EXPR = "$json.data?.[0]?.url ?? $json.images?.[0]?.url ?? ''"


def add_image_wait(wf, image_node, x, y, label, on_error=None):
    """/images/generations answers 202 with queue links when the image takes over ~110 s.

    Ready → a Set node with `image_url`; queued → Wait 10 s → GET response_url → check again.
    Returns the name of the Set node.
    """
    ready = wf.add(
        f"{label} ready?",
        "n8n-nodes-base.if",
        2.2,
        (x, y),
        {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                "conditions": [
                    {
                        "id": uid(f"ready-{label}", wf.slug),
                        "leftValue": "={{ " + IMAGE_URL_EXPR + " }}",
                        "rightValue": "",
                        "operator": {"type": "string", "operation": "notEmpty", "singleValue": True},
                    }
                ],
                "combinator": "and",
            },
            "options": {},
        },
    )
    url = wf.add(
        f"{label} URL",
        "n8n-nodes-base.set",
        3.4,
        (x + 220, y - 100),
        {
            "assignments": {
                "assignments": [
                    {"id": uid(f"url-{label}", wf.slug), "name": "image_url",
                     "value": "={{ " + IMAGE_URL_EXPR + " }}", "type": "string"},
                ]
            },
            "options": {},
        },
    )
    wait = wf.add(
        f"Queued: wait 10s ({label})",
        "n8n-nodes-base.wait",
        1.1,
        (x + 220, y + 120),
        {"amount": 10},
        webhookId=uid(f"wait-img-{label}", wf.slug),
    )
    extra = {"onError": "continueErrorOutput"} if on_error else {}
    fetch = wf.add(
        f"Fetch queued {label.lower()}",
        "n8n-nodes-base.httpRequest",
        4.2,
        (x + 440, y + 120),
        http_get("={{ $json.response_url }}"),
        credentials=CRED,
        **extra,
    )
    wf.link(image_node, ready)
    wf.link(ready, url, out=0)
    wf.link(ready, wait, out=1)
    wf.link(wait, fetch)
    wf.link(fetch, ready)
    if on_error:
        wf.link(fetch, on_error, out=1)
    return url


def add_form_ending(wf, name, pos, html):
    return wf.add(
        name,
        "n8n-nodes-base.form",
        2.3,
        pos,
        {
            "operation": "completion",
            "respondWith": "showText",
            "responseText": "=<div style=\"font-family:system-ui,-apple-system,sans-serif;max-width:640px;"
            "margin:48px auto;padding:24px;line-height:1.5\">" + html.lstrip("=") + "</div>",
        },
        webhookId=uid(f"form-end-{name}", wf.slug),
    )


SETUP = (
    "## Setup (2 minutes)\n"
    "1. Get a key at [getmegabrain.com/keys](https://getmegabrain.com/keys).\n"
    "2. In n8n create a **Header Auth** credential named `MegaBrain API key`:\n"
    "   - Name: `Authorization`\n"
    "   - Value: `Bearer YOUR_KEY`\n"
    "3. Pick it in every HTTP Request node with the 🔑 mark.\n\n"
    "Failed jobs are refunded automatically. Prices: [getmegabrain.com/docs/media](https://getmegabrain.com/docs/media)."
)

templates = []

# ============================================================================= 1. Telegram → Nano Banana Pro
wf = WF("telegram-image-bot-nano-banana-pro", "Telegram AI image bot with Nano Banana Pro (MegaBrain)")
wf.note(
    "About",
    (-520, -260),
    "# Telegram image bot — Nano Banana Pro\n"
    "Send the bot a description, get back a 2K image made by Google **Nano Banana Pro** "
    "through the MegaBrain API ($0.17 an image, pay as you go).\n\n" + SETUP + "\n\n"
    "Also create a **Telegram** credential with your bot token from @BotFather.",
    width=440,
    height=560,
)
trigger = wf.add(
    "Telegram Trigger",
    "n8n-nodes-base.telegramTrigger",
    1.2,
    (0, 0),
    {"updates": ["message"], "additionalFields": {}},
    webhookId=uid("tg-trigger", wf.slug),
    credentials={"telegramApi": {"id": "tgBotCredential01", "name": "Telegram bot"}},
)
settings = wf.add(
    "Settings",
    "n8n-nodes-base.set",
    3.4,
    (200, 0),
    {
        "assignments": {
            "assignments": [
                {"id": uid("set1", wf.slug), "name": "model", "value": "nano-banana-pro", "type": "string"},
                {"id": uid("set2", wf.slug), "name": "aspect_ratio", "value": "1:1", "type": "string"},
                {"id": uid("set3", wf.slug), "name": "resolution", "value": "2K", "type": "string"},
                {"id": uid("set4", wf.slug), "name": "caption",
                 "value": "Made with Nano Banana Pro on getmegabrain.com", "type": "string"},
            ]
        },
        "includeOtherFields": True,
        "options": {},
    },
)
typing = wf.add(
    "Show 'sending photo'",
    "n8n-nodes-base.telegram",
    1.2,
    (420, 0),
    {
        "operation": "sendChatAction",
        "chatId": "={{ $json.message.chat.id }}",
        "action": "upload_photo",
    },
    webhookId=uid("tg-typing", wf.slug),
    credentials={"telegramApi": {"id": "tgBotCredential01", "name": "Telegram bot"}},
)
gen = wf.add(
    "Generate image (Nano Banana Pro)",
    "n8n-nodes-base.httpRequest",
    4.2,
    (640, 0),
    http_post(
        "/images/generations",
        "={{ JSON.stringify({ model: $('Settings').item.json.model, prompt: $('Telegram Trigger').item.json.message.text, "
        "aspect_ratio: $('Settings').item.json.aspect_ratio, resolution: $('Settings').item.json.resolution, "
        "output_format: 'jpeg' }) }}",
    ),
    credentials=CRED,
    onError="continueErrorOutput",
)
send = wf.add(
    "Send photo",
    "n8n-nodes-base.telegram",
    1.2,
    (1340, -100),
    {
        "operation": "sendPhoto",
        "chatId": "={{ $('Telegram Trigger').item.json.message.chat.id }}",
        "file": "={{ $json.image_url }}",
        "additionalFields": {"caption": "={{ $('Settings').item.json.caption }}"},
    },
    webhookId=uid("tg-photo", wf.slug),
    credentials={"telegramApi": {"id": "tgBotCredential01", "name": "Telegram bot"}},
)
err = wf.add(
    "Tell the user it failed",
    "n8n-nodes-base.telegram",
    1.2,
    (1340, 260),
    {
        "chatId": "={{ $('Telegram Trigger').item.json.message.chat.id }}",
        "text": "=Could not make the image: {{ $json.error?.message || 'unknown error' }}",
        "additionalFields": {"appendAttribution": False},
    },
    webhookId=uid("tg-error", wf.slug),
    credentials={"telegramApi": {"id": "tgBotCredential01", "name": "Telegram bot"}},
)
wf.link(typing, gen)
image_url = add_image_wait(wf, gen, 860, 0, "Image", on_error=err)
wf.link(trigger, settings)
wf.link(settings, typing)
wf.link(image_url, send)
wf.note(
    "Note: settings",
    (140, -260),
    "## 1. Settings\nChange the model, frame and caption here. `resolution` 4K costs twice as much; "
    "for cheaper drafts use `nano-banana-2` or `flux-2` (FLUX takes no `resolution`: remove it from the request).",
    width=420,
    height=220,
    color=5,
)
wf.note(
    "Note: queue",
    (820, -260),
    "## 2. Wait for a queued image\nThe API waits up to ~110 s. A slower image comes back as `202` with a "
    "`response_url`: the loop waits 10 s and asks again until the image is ready. A failed job is refunded "
    "and the user gets the reason.",
    width=460,
    height=220,
    color=5,
)
wf.link(gen, err, out=1)
templates.append(
    wf.write(
        "Telegram bot that turns any message into a 2K Nano Banana Pro image via the MegaBrain API, "
        "with a friendly reply when generation fails."
    )
)

# ============================================================================= 2. Idea → Kling 3 video
wf = WF("text-to-video-kling-3", "Generate AI videos with Kling 3 from a form (MegaBrain)")
wf.note(
    "About",
    (-520, -280),
    "# Idea → Kling 3 video\n"
    "Type an idea in the form. A free text model (`mb-auto/free`) turns it into a cinematic prompt, "
    "**Kling 3** renders the clip, and the form shows the video link.\n\n"
    "Kling 3 standard costs $0.097 a second without sound (5 s ≈ $0.48).\n\n" + SETUP + "\n\n"
    "**Post it next:** add a YouTube, TikTok (Blotato) or Google Drive node after *Video link*.",
    width=440,
    height=600,
)
form = wf.add(
    "Video idea form",
    "n8n-nodes-base.formTrigger",
    2.2,
    (0, 0),
    {
        "formTitle": "Make a video with Kling 3",
        "formDescription": "Describe the scene. The video link appears here when it is ready (1–3 minutes).",
        "formFields": {
            "values": [
                {"fieldLabel": "Idea", "fieldType": "textarea", "requiredField": True,
                 "placeholder": "a drone flies over a snowy mountain lake at sunrise"},
                {"fieldLabel": "Seconds", "fieldType": "dropdown",
                 "fieldOptions": {"values": [{"option": "3"}, {"option": "5"}, {"option": "10"}]},
                 "requiredField": True},
                {"fieldLabel": "Sound", "fieldType": "dropdown",
                 "fieldOptions": {"values": [{"option": "no"}, {"option": "yes"}]}, "requiredField": True},
            ]
        },
        "options": {},
    },
    webhookId=uid("form", wf.slug),
)
writer = wf.add(
    "Write the prompt (free model)",
    "n8n-nodes-base.httpRequest",
    4.2,
    (220, 0),
    http_post(
        "/chat/completions",
        "={{ JSON.stringify({ model: '" + FREE_MODEL + "', messages: [ { role: 'system', content: "
        "'You write prompts for the Kling video model. Reply with one paragraph under 60 words: subject, action, "
        "camera movement, lighting, style. No preamble, no quotes.' }, { role: 'user', content: $json.Idea } ] }) }}",
    ),
    credentials=CRED,
    retryOnFail=True,
    waitBetweenTries=3000,
)
submit = wf.add(
    "Submit Kling 3 job",
    "n8n-nodes-base.httpRequest",
    4.2,
    (440, 0),
    http_post(
        "/queue/kling-video/v3/standard/text-to-video",
        "={{ JSON.stringify({ prompt: $json.choices[0].message.content.trim(), "
        "duration: $('Video idea form').item.json.Seconds, "
        "generate_audio: $('Video idea form').item.json.Sound === 'yes', aspect_ratio: '16:9' }) }}",
    ),
    credentials=CRED,
)
link = wf.add(
    "Video link",
    "n8n-nodes-base.set",
    3.4,
    (1580, -120),
    {
        "assignments": {
            "assignments": [
                {"id": uid("a1", wf.slug), "name": "video_url", "value": "={{ $json.video.url }}", "type": "string"},
                {"id": uid("a2", wf.slug), "name": "prompt",
                 "value": "={{ $('Write the prompt (free model)').item.json.choices[0].message.content.trim() }}",
                 "type": "string"},
            ]
        },
        "options": {},
    },
)
done = add_form_ending(
    wf,
    "Show the video",
    (1800, -120),
    "=<h2>Your video is ready</h2><p><a href=\"{{ $json.video_url }}\" target=\"_blank\">Open the video</a></p>"
    "<p><video src=\"{{ $json.video_url }}\" controls style=\"max-width:100%\"></video></p>"
    "<p>Prompt: {{ $json.prompt }}</p>",
)
wf.link(form, writer)
wf.link(writer, submit)
add_poll_loop(wf, submit, 660, 0, "video", 15, link)
wf.link(link, done)
wf.note(
    "Note: prompt",
    (160, -260),
    "## 1. Prompt and job\nThe free model `mb-auto/free` turns the idea into a Kling prompt (no charge). "
    "The job is then submitted to the queue; its price is charged at submit and refunded if it fails.",
    width=420,
    height=220,
    color=5,
)
wf.note(
    "Note: poll",
    (640, -300),
    "## 2. Poll the job\nEvery 15 s the loop reads `status_url`. `COMPLETED` → fetch the video from "
    "`response_url`; `FAILED` → stop with an error (the price is back on your balance); anything else → wait again.",
    width=560,
    height=180,
    color=5,
)
templates.append(
    wf.write(
        "A form that turns a one-line idea into a Kling 3 video: a free LLM writes the prompt, the MegaBrain "
        "queue renders the clip, and a wait/poll loop returns the video URL."
    )
)

# ============================================================================= 3. Instagram carousel with FLUX 2
wf = WF("instagram-carousel-flux-2", "Instagram carousel images and caption with FLUX 2 (MegaBrain)")
wf.note(
    "About",
    (-520, -280),
    "# Instagram carousel — FLUX 2\n"
    "Give a topic. A free text model plans the slides and writes the caption, **FLUX 2** draws every slide "
    "in 4:5, and the last node returns the image URLs plus the caption, ready for Instagram, Blotato or Drive.\n\n"
    "FLUX 2 costs $0.014 per megapixel: a 5-slide carousel is about $0.14.\n\n" + SETUP,
    width=440,
    height=560,
)
start = wf.add("Start", "n8n-nodes-base.manualTrigger", 1, (0, 0), {})
topic = wf.add(
    "Topic",
    "n8n-nodes-base.set",
    3.4,
    (200, 0),
    {
        "assignments": {
            "assignments": [
                {"id": uid("t1", wf.slug), "name": "topic", "value": "5 morning habits of calm people", "type": "string"},
                {"id": uid("t2", wf.slug), "name": "slides", "value": 5, "type": "number"},
                {"id": uid("t3", wf.slug), "name": "style",
                 "value": "soft pastel editorial photography, natural light, lots of empty space for text",
                 "type": "string"},
            ]
        },
        "options": {},
    },
)
plan = wf.add(
    "Plan slides (free model)",
    "n8n-nodes-base.httpRequest",
    4.2,
    (420, 0),
    http_post(
        "/chat/completions",
        "={{ JSON.stringify({ model: '" + FREE_MODEL + "', response_format: { type: 'json_object' }, messages: [ "
        "{ role: 'system', content: 'You plan Instagram carousels. Reply with JSON only: {\"caption\": string with hashtags, "
        "\"slides\": [{\"title\": short slide headline, \"prompt\": image prompt without any text in the picture}]}' }, "
        "{ role: 'user', content: `Topic: ${$json.topic}. Slides: ${$json.slides}. Visual style: ${$json.style}` } ] }) }}",
    ),
    credentials=CRED,
    retryOnFail=True,
    waitBetweenTries=3000,
)
parse = wf.add(
    "Parse the plan",
    "n8n-nodes-base.code",
    2,
    (640, 0),
    {
        "jsCode": (
            "const raw = $input.first().json.choices[0].message.content;\n"
            "const text = raw.replace(/^```(?:json)?\\s*/i, '').replace(/```\\s*$/, '').trim();\n"
            "const plan = JSON.parse(text);\n"
            "const { style, slides } = $('Topic').first().json;\n"
            "return plan.slides.slice(0, slides).map((slide, index) => ({\n"
            "  json: { index: index + 1, title: slide.title, prompt: `${slide.prompt.replace(/[.\s]+$/, '')}. ${style}`, caption: plan.caption },\n"
            "}));"
        )
    },
)
loop = wf.add(
    "One slide at a time",
    "n8n-nodes-base.splitInBatches",
    3,
    (860, 0),
    {"options": {}},
)
draw = wf.add(
    "Draw slide (FLUX 2)",
    "n8n-nodes-base.httpRequest",
    4.2,
    (1080, 100),
    http_post(
        "/images/generations",
        "={{ JSON.stringify({ model: 'flux-2', prompt: $json.prompt, image_size: { width: 1080, height: 1350 } }) }}",
    ),
    credentials=CRED,
)
collect = wf.add(
    "Carousel",
    "n8n-nodes-base.code",
    2,
    (1080, -140),
    {
        "jsCode": (
            "const slides = $input.all().map((item) => item.json);\n"
            "return [{ json: {\n"
            "  caption: slides[0]?.caption,\n"
            "  images: slides.map(({ index, title, image_url }) => ({ slide: index, title, url: image_url })),\n"
            "} }];"
        )
    },
)
for a, b in [(start, topic), (topic, plan), (plan, parse), (parse, loop)]:
    wf.link(a, b)
wf.link(loop, collect, out=0)
wf.link(loop, draw, out=1)
slide_url = add_image_wait(wf, draw, 1300, 100, "Slide")
slide = wf.add(
    "Slide",
    "n8n-nodes-base.set",
    3.4,
    (1740, 0),
    {
        "assignments": {
            "assignments": [
                {"id": uid("s1", wf.slug), "name": "index", "value": "={{ $('One slide at a time').first().json.index }}", "type": "number"},
                {"id": uid("s2", wf.slug), "name": "title", "value": "={{ $('One slide at a time').first().json.title }}", "type": "string"},
                {"id": uid("s3", wf.slug), "name": "caption", "value": "={{ $('One slide at a time').first().json.caption }}", "type": "string"},
                {"id": uid("s4", wf.slug), "name": "image_url", "value": "={{ $json.image_url }}", "type": "string"},
            ]
        },
        "options": {},
    },
)
wf.link(slide_url, slide)
wf.link(slide, loop)
wf.note(
    "Note: plan",
    (160, -260),
    "## 1. Plan\nEdit **Topic**: subject, number of slides, visual style. The free model returns JSON with a "
    "caption and one image prompt per slide; **Parse the plan** strips code fences and keeps the slide count.",
    width=440,
    height=220,
    color=5,
)
wf.note(
    "Note: draw",
    (1040, -300),
    "## 2. Draw slides one by one\nEach slide goes through FLUX 2 at 1080×1350. If an image is not ready in "
    "~110 s the loop polls `response_url`. When all slides are done, **Carousel** returns the caption and the URLs.",
    width=520,
    height=200,
    color=5,
)
templates.append(
    wf.write(
        "Plans an Instagram carousel with a free LLM, draws each slide with FLUX 2 at 1080×1350 through the "
        "MegaBrain API, and returns the slide URLs with a ready caption."
    )
)

# ============================================================================= 4. Product photo → UGC video ad
wf = WF("product-photo-to-video-ad", "Product photo to video ad with Nano Banana Pro and Kling 3 (MegaBrain)")
wf.note(
    "About",
    (-520, -300),
    "# Product photo → video ad\n"
    "Upload-free UGC ad pipeline: paste a product photo URL and one line about the product.\n"
    "1. A free text model writes the scene.\n"
    "2. **Nano Banana Pro Edit** puts the product into a lifestyle shot (keeps the label).\n"
    "3. **Kling 3** animates that shot into a vertical 5-second clip.\n\n"
    "Cost: about $0.17 for the image + $0.48 for 5 s of video.\n\n" + SETUP,
    width=440,
    height=620,
)
form = wf.add(
    "Product form",
    "n8n-nodes-base.formTrigger",
    2.2,
    (0, 0),
    {
        "formTitle": "Product photo → video ad",
        "formDescription": "Paste a public link to a product photo. The video link appears here in 2–4 minutes.",
        "formFields": {
            "values": [
                {"fieldLabel": "Product photo URL", "requiredField": True,
                 "placeholder": "https://…/bottle.png"},
                {"fieldLabel": "Product", "requiredField": True,
                 "placeholder": "cold brew coffee in a glass bottle"},
                {"fieldLabel": "Audience", "placeholder": "busy students"},
            ]
        },
        "options": {},
    },
    webhookId=uid("form", wf.slug),
)
scene = wf.add(
    "Write the scene (free model)",
    "n8n-nodes-base.httpRequest",
    4.2,
    (220, 0),
    http_post(
        "/chat/completions",
        "={{ JSON.stringify({ model: '" + FREE_MODEL + "', response_format: { type: 'json_object' }, messages: [ "
        "{ role: 'system', content: 'You direct short UGC-style product ads. Reply with JSON only: "
        "{\"image_prompt\": how to place the product from the photo in a realistic lifestyle scene, keep the product and its label unchanged, "
        "\"video_prompt\": what happens in 5 seconds, natural handheld phone camera, one simple action}' }, "
        "{ role: 'user', content: `Product: ${$json.Product}. Audience: ${$json.Audience || 'everyone'}` } ] }) }}",
    ),
    credentials=CRED,
    retryOnFail=True,
    waitBetweenTries=3000,
)
parse = wf.add(
    "Parse the scene",
    "n8n-nodes-base.code",
    2,
    (440, 0),
    {
        "jsCode": (
            "const raw = $input.first().json.choices[0].message.content;\n"
            "const text = raw.replace(/^```(?:json)?\\s*/i, '').replace(/```\\s*$/, '').trim();\n"
            "return [{ json: JSON.parse(text) }];"
        )
    },
)
shot = wf.add(
    "Lifestyle shot (Nano Banana Pro Edit)",
    "n8n-nodes-base.httpRequest",
    4.2,
    (660, 0),
    http_post(
        "/images/generations",
        "={{ JSON.stringify({ model: 'nano-banana-pro/edit', prompt: $json.image_prompt, "
        "image_urls: [ $('Product form').item.json['Product photo URL'] ], aspect_ratio: '9:16', resolution: '1K' }) }}",
    ),
    credentials=CRED,
)
submit = wf.add(
    "Submit Kling 3 image-to-video",
    "n8n-nodes-base.httpRequest",
    4.2,
    (1320, -100),
    http_post(
        "/queue/kling-video/v3/standard/image-to-video",
        "={{ JSON.stringify({ prompt: $('Parse the scene').item.json.video_prompt, start_image_url: $json.image_url, "
        "duration: '5', generate_audio: false }) }}",
    ),
    credentials=CRED,
)
out = wf.add(
    "Ad links",
    "n8n-nodes-base.set",
    3.4,
    (2460, -220),
    {
        "assignments": {
            "assignments": [
                {"id": uid("o1", wf.slug), "name": "video_url", "value": "={{ $json.video.url }}", "type": "string"},
                {"id": uid("o2", wf.slug), "name": "image_url",
                 "value": "={{ $('Shot URL').item.json.image_url }}", "type": "string"},
            ]
        },
        "options": {},
    },
)
for a, b in [(form, scene), (scene, parse), (parse, shot)]:
    wf.link(a, b)
shot_url = add_image_wait(wf, shot, 880, 0, "Shot")
wf.link(shot_url, submit)
add_poll_loop(wf, submit, 1540, -100, "video", 15, out)
ad_done = add_form_ending(
    wf,
    "Show the ad",
    (2680, -220),
    "=<h2>Your ad is ready</h2><p><a href=\"{{ $json.video_url }}\" target=\"_blank\">Open the video</a> · "
    "<a href=\"{{ $json.image_url }}\" target=\"_blank\">Open the image</a></p>"
    "<p><video src=\"{{ $json.video_url }}\" controls style=\"max-width:100%\"></video></p>",
)
wf.link(out, ad_done)
wf.note(
    "Note: scene",
    (160, -300),
    "## 1. Scene\nThe free model writes two prompts as JSON: the lifestyle shot and a 5-second action. "
    "The photo URL must be public (no login, no Google Drive preview links).",
    width=420,
    height=220,
    color=5,
)
wf.note(
    "Note: shot and video",
    (840, -420),
    "## 2. Shot, then video\n**Nano Banana Pro Edit** keeps the product and label from the photo. The shot "
    "feeds **Kling 3 image-to-video**; the loop polls the job every 15 s and the form shows both links.",
    width=560,
    height=200,
    color=5,
)
templates.append(
    wf.write(
        "UGC-style ad from one product photo: a free LLM writes the scene, Nano Banana Pro Edit makes a lifestyle "
        "shot that keeps the label, and Kling 3 animates it into a vertical clip."
    )
)

# ============================================================================= 5. AI agent on 100+ models
wf = WF("ai-agent-any-model", "AI agent on 100+ models with one key (MegaBrain, OpenAI-compatible)")
wf.note(
    "About",
    (-520, -300),
    "# AI agent on any model\n"
    "n8n's **OpenAI Chat Model** node works with MegaBrain: one key, 100+ models (Claude, GPT, Gemini, "
    "Kimi, GLM, Qwen, DeepSeek…) and a free one, `mb-auto/free`.\n\n"
    "## Setup\n"
    "1. Get a key at [getmegabrain.com/keys](https://getmegabrain.com/keys).\n"
    "2. Create an **OpenAI** credential:\n"
    "   - API Key: your MegaBrain key\n"
    "   - Base URL: `https://getmegabrain.com/api/gateway/v1`\n"
    "3. Open the chat and talk. Change the model in *MegaBrain model* — the list loads from your account.\n\n"
    "All models: [getmegabrain.com/models](https://getmegabrain.com/models)",
    width=440,
    height=600,
)
chat = wf.add(
    "When chat message received",
    "@n8n/n8n-nodes-langchain.chatTrigger",
    1.1,
    (0, 0),
    {"options": {}},
    webhookId=uid("chat", wf.slug),
)
agent = wf.add(
    "AI Agent",
    "@n8n/n8n-nodes-langchain.agent",
    1.9,
    (240, 0),
    {"options": {"systemMessage": "You are a helpful assistant. Answer briefly."}},
)
model = wf.add(
    "MegaBrain model",
    "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    1.2,
    (160, 220),
    {
        "model": {"__rl": True, "value": FREE_MODEL, "mode": "id"},
        "options": {},
    },
    credentials={"openAiApi": {"id": "mbOpenAiCompat01", "name": "MegaBrain (OpenAI-compatible)"}},
)
memory = wf.add(
    "Memory",
    "@n8n/n8n-nodes-langchain.memoryBufferWindow",
    1.3,
    (340, 220),
    {},
)
wf.link(chat, agent)
wf.link(model, agent, kind="ai_languageModel")
wf.link(memory, agent, kind="ai_memory")
templates.append(
    wf.write(
        "A chat AI agent whose OpenAI Chat Model node points at MegaBrain: one key for Claude, GPT, Gemini, "
        "Kimi, GLM and more, and a free model to start."
    )
)

(OUT / "index.json").write_text(json.dumps(templates, indent=2, ensure_ascii=False) + "\n")
print("\n".join(t["file"] for t in templates))
