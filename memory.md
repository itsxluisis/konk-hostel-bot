**Purpose & context**

Luis is automating **Konk Hostel**, a recently acquired property in La Manga del Mar Menor, Murcia, Spain, operated through his company **Rentalme.es**. The goal is 100% remote, staff-free operations. Core automation stack:

- **Cloudbeds** – PMS
- **UpMarket** – messaging bot / virtual concierge
- **Vikey** – online check-in and smart lock access
- **PricePoint** – dynamic pricing
- **Vapi** – AI voice assistant for call handling

**Current state**

**Call-handling architecture (finalized):**
Android SIM → unconditional call forward (`*21*`) → Sipgate Free (SIP bridge) → Vapi SIP trunk → AI assistant. Luis cannot purchase numbers directly in Vapi due to plan restrictions, so the SIP trunk import method via API calls is the workaround.

**Vapi assistant:**
A comprehensive system prompt has been produced (English), including tool call definitions for: `check_reservation`, `get_availability`, `create_reservation` (disabled), `get_cabinet_code`, and `alert_staff`. A Spanish-language knowledge base document for UpMarket has also been produced. Both contain placeholder markers for cabinet codes.

**Admin panel:**
A React-based single-HTML-file admin panel was built, connecting to Vapi via API key. Features: prompt editing, knowledge base management, voice/language config, browser test calls, call history with transcriptions, and an emergency detection panel.

**Unresolved issue – security risk:**
The bot is hallucinating reservation verifications because the `check_reservation` webhook does not yet exist. Luis was presented with two options (deploy a minimal blocking endpoint vs. temporarily disable verification in the prompt) but did not select one before the conversation ended. **This requires a decision before going live.**

**Vapi API key was accidentally shared in chat** – Luis was advised to regenerate it immediately. Status of this action is unconfirmed.

**Key operational details (Konk Hostel):**

- Fully remote, no physical reception; staff alerts via Telegram
- **Vikey check-in flow:** link sent at booking, Spanish law requires document upload, access active 15:00–11:00, requires mobile data, two interaction modes (PIN or electronic handle)
- **Physical emergency cabinet system:** exterior lower (main entrance), exterior upper (independent-access room), interior numbered cabinets per room type — different protocols for private rooms vs. 4-person vs. 6-person shared dorms
- **No exceptions policy:** no early/late check-out under any circumstances, no post-checkout luggage storage; individual lockers available during stay only
- **No services:** no bar, no transfers, no bike rental
- **Bookings:** currently redirecting new reservations to Booking.com while direct payment gateway is rebuilt; Cloudbeds API integration was expected imminently

**On the horizon**

- Decide on `check_reservation` webhook solution (minimal blocking endpoint vs. prompt-level disable) before deploying the Vapi assistant
- Confirm Vapi API key has been regenerated
- Cloudbeds API integration (direct booking gateway rebuild)
- Populate cabinet code placeholders in both the Vapi system prompt and UpMarket knowledge base

**Tools & resources**

| Tool | Role |
|---|---|
| Vapi | AI voice assistant / call handling |
| Sipgate Free | SIP bridge from Android SIM to Vapi |
| Cloudbeds | PMS |
| UpMarket | Guest messaging bot / virtual concierge |
| Vikey | Online check-in + smart lock access |
| PricePoint | Dynamic pricing |
| Telegram | Staff incident alerts |
| Booking.com | Current channel for new reservations |
| Rentalme.es | Luis's operating company |
