
  # Design User Interface for ClinOps

  This is a code bundle for Design User Interface for ClinOps. The original project is available at https://www.figma.com/design/mkzq9tLHEgIDcJB0tRCGwp/Design-User-Interface-for-ClinOps.

  ## Running the code

  Copy env values if needed:

  `cp .env.example .env`

  Configure:
  - `VITE_API_BASE_URL` (backend URL, default `http://localhost:4000`)
  - `VITE_DEV_USER_ID` + `VITE_DEV_ROLE` for backend dev-header auth mode

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

  Run `npm run build` for a production build verification.

  Verification scripts:
  - `npm run test:contract` (API contract smoke checks)
  - `npm run test:visual` (build + artifact checks)
  - `npm run test:e2e-live` (live encounter flow smoke test)
  
