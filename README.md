# MemeCut AI v0.2

MemeCut AI is een lokale editor voor langere YouTube-gamingvideo's. De AI-regisseur gebruikt een transcript met tijdcodes en maximaal twaalf gameplayframes om maximaal drie edits te kiezen. De beeldselectie combineert verspreide frames met beelden rond maximaal twee opvallende beeldwissels. Iedere edit kan een originele memeafbeelding, tekst, zoom en een kort geluid bevatten. Op de tijdlijn kun je edits en cuts aanpassen. FFmpeg maakt een 16:9 MP4 van de bewaarde gameplayfragmenten.

## Lokaal starten

Je hebt Node.js 22.9 of nieuwer en FFmpeg met FFprobe en de H.264- en AAC-encoders nodig. Zet de twee programma's op je PATH of vul hun paden in via `FFMPEG_PATH` en `FFPROBE_PATH`. Er zijn geen npm-pakketten om te installeren.

Maak voor AI-analyse een lokaal bestand `.env` op basis van `.env.example`. Vul daar je `OPENAI_API_KEY` in. Op deze machine zijn de paden van FFmpeg en FFprobe uit Shotcut lokaal ingesteld.

```powershell
npm start
```

Open daarna [MemeCut AI](http://127.0.0.1:8765). Importeer een MP4, MOV of WebM van 2–10 minuten die je browser kan afspelen. Begin met een clip van ongeveer drie minuten. Voor AI-analyse en FFmpeg-export geldt een bronlimiet van 256 MiB.

1. Kies **AI-montage maken**. Alleen audio en geselecteerde frames worden voor deze actie naar OpenAI gestuurd. De oorspronkelijke video blijft op je computer. Zonder API-sleutel kun je lokaal audiopieken zoeken en zelf edits toevoegen.
2. Kies een moment om de meme, timing en reden te bekijken. Met **Cuts** bepaal je maximaal zes bronfragmenten die je wilt behouden. Bewerkte weergave slaat de overige delen over.
3. Kies **Exporteren** en daarna **MP4 renderen**. De lokale server maakt een H.264/AAC MP4 van 1280 × 720. Het JSON-plan bevat tijdcodes uit de oorspronkelijke bronvideo.

OpenAI gebruikt standaard `gpt-4.1-mini` voor de montagekeuze en `gpt-4o-transcribe-diarize` voor tijdgebonden spraakherkenning. Stel desgewenst `OPENAI_VISION_MODEL` en `OPENAI_TRANSCRIPTION_MODEL` in. De transcriptie ondersteunt ook `whisper-1`. OpenAI heeft de uitfasering van beide ondersteunde transcriptiemodellen gepland voor 26 februari 2027. [Transcriptie met OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text) · [Beeldinvoer](https://developers.openai.com/api/docs/guides/images-vision) · [Gestructureerde uitvoer](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)

Als de aanwijzingen te zwak zijn, kan het model zonder memes terugkomen. De backend weigert overlappende edits, onbekende memes en edits buiten de bewaarde fragmenten. Uploads en renders worden tijdelijk lokaal bewaard en verlopen na een uur zonder activiteit. De server is bedoeld voor gebruik op localhost.

## Broncode en verificatie

- `src/web/` bevat de browsereditor en [tien originele PNG-reactiestickers](src/web/assets/memes/README.md). `npm run build` maakt een statische kopie in `dist/`. Voor AI, cuts en meme-export gebruik je `npm start`.
- `src/ai.mjs` zet transcript en frames om in een voorstel. `src/plan.mjs` valideert het voorstel voordat `src/media.mjs` het met FFmpeg uitvoert.
- `npm test` controleert modelverzoeken met gesimuleerde OpenAI-antwoorden, de HTTP-routes, tijdcodes, ongeldige uploads, overlaps en echte MP4-rendering met synthetische media. De mediatests slaan over wanneer FFmpeg of FFprobe ontbreekt.

De Minecraft-demo gebruikt een vooraf samengesteld plan bij een stilstaand beeld. Het demobeeld en de reactiestickers zijn gemaakt met ImageGen. De FFmpeg-export gebruikt een ingebouwd pixellettertype met ondersteuning voor Latijnse letters, gangbare leestekens en enkele emoji's.
