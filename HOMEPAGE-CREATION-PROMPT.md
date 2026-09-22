# 10/10 Astro homepage creation prompt

Create a production-quality, homepage-only Astro website for a product currently named **MeshKit**: a private, browser-based toolkit for viewing, converting, repairing and optimizing 3D files.

## Business model and purpose

The site acquires users only through organic SEO. Visitors arrive with high-intent problems such as “STL viewer,” “3MF to STL,” “STL repair,” “OBJ to STL,” “GLB to STL” and “G-code viewer.” The free browser tools solve a real single-file problem completely. The commercial offer is a **$39 one-time Pro product** for painful repeat work such as processing many files, folders or recurring jobs.

The homepage must sell the trust and positioning behind the product. Do **not** build any working tool, viewer, converter, file upload, drag-and-drop behavior, checkout, account, authentication, database, backend or paid product. This task is the homepage only. Buttons may navigate between sections or represent future links, but they must not pretend that unimplemented functionality works.

## Strategic design direction

Combine three ideas into one coherent homepage:

1. **Precision Flow** for the visual identity and hero: clean, modern, polished, highly legible and upload-intent focused.
2. **Tool Atlas** for homepage discovery: make the main tool categories easy to scan without turning the page into a cluttered directory.
3. **Outcome First** for the free-to-paid story: show that the free experience solves one file, while Pro removes repetitive work when one file becomes a folder.

The page should feel trustworthy enough for engineers, makers and designers, but colorful and energetic enough to be memorable. It should not look like a generic SaaS template.

## Visual system

- Use a bright, controlled multicolor palette: saturated violet as the primary color, hot pink and electric cyan as secondary accents, with touches of mint and warm amber.
- Use a near-white cool background, crisp white surfaces, dark ink typography and one dark technical section.
- Use gradients selectively for primary actions, hero emphasis, the generated 3D visual and contextual Pro highlights.
- Use large, confident typography with tight display lettering and highly readable body text.
- Use rounded panels, light borders, soft layered shadows and restrained glass effects.
- Avoid washed-out beige, generic blue SaaS styling, excessive neon, cryptocurrency aesthetics, cartoon illustrations, stock photos and overcrowded dashboards.
- Include a polished, transparent-background 3D mesh artwork in the hero. It should be a faceted mechanical or abstract model rendered in violet, cyan, pink and amber glass/metal materials. Do not bake page copy into the image.
- Add smooth, subtle scroll reveals and a gentle floating motion for the hero model. Respect `prefers-reduced-motion`.

## Required homepage structure

### 1. Privacy announcement

Use a slim multicolor dark strip above the navigation with a short message such as:

> 100% local processing — your files never leave your computer

### 2. Sticky navigation

Include:

- MeshKit wordmark and a simple geometric mesh/cube mark
- Popular tools
- Why private
- Pro
- FAQ
- Primary CTA: “Explore free tools”
- Accessible mobile menu

### 3. Hero

The first viewport must establish the promise immediately.

Suggested copy:

**Eyebrow:** Private browser tools

**Headline:** Your 3D files, fixed in your browser.

**Supporting copy:** Open, inspect, convert and repair STL, 3MF, OBJ, GLB and G-code files—without uploading a single byte.

Primary CTA: **Choose a free tool**

Secondary CTA: **See how privacy works**

Trust points:

- No signup
- No upload
- Full-quality output

Place the 3D mesh hero artwork inside a refined mock viewer card. Add small, believable UI details such as a filename, “Local” status, mesh-health indicator and a “Never uploaded” callout. These are static visual elements only.

### 4. Proof bar

Use a compact horizontal proof strip with four honest points:

- 100% browser-based
- 0 files uploaded
- 7+ focused file tools
- $39 once for Pro

Do not invent customer counts, testimonials, ratings or company logos.

### 5. Popular tool discovery

Headline direction:

> The right tool, without the detour.

Show four colorful discovery cards:

- STL Viewer — Inspect geometry, dimensions and triangle count.
- 3MF to STL — Convert clean geometry without uploading the model.
- STL Repair — Find holes, bad normals and non-manifold edges.
- G-code Viewer — Preview layers, toolpaths and estimated moves.

Each card should have a distinct soft color, a small technical icon, a short label and concise copy. Keep the cards static or link them to anchors because the tool routes are outside scope.

### 6. Private-by-architecture section

Use a dark technical section with a simple visual flow:

> Your file → Your browser → Finished file

Explain three steps:

1. Select a file on the device.
2. Process it locally with JavaScript, WebAssembly and browser workers.
3. Save the result directly from the browser.

The central message must be:

> Your design stays your design.

Avoid vague security claims. Specifically explain that the model is not sent to a conversion server.

### 7. Free-to-Pro conversion story

Use two distinct panels joined by a clear transition.

**Free browser tools:**

- Complete single-file workflow
- No account
- Private local processing
- Full-quality downloads

**MeshKit Pro:**

- Batch entire folders
- Reusable repair and optimization presets
- Large-file mode
- Offline use
- No ads
- $39 once, yours forever

The page must never imply that basic single-file functionality is crippled. Pro should sell time savings, volume and convenience.

### 8. Contextual sales moment

Show a static conversion-success panel followed by the strongest contextual upsell:

> File converted successfully.

> Need to convert 37 more?

Explain that Pro processes the whole folder. Frame this as the natural moment to upgrade because the repetitive pain is now obvious.

### 9. FAQ

Include concise answers for:

- Are files uploaded?
- Is an account required?
- What is included in Pro?
- Is Pro a subscription?
- Which formats are supported?

Use accessible native `<details>` and `<summary>` elements.

### 10. Final CTA and footer

Close with:

> Your file. Your browser. Your call.

> Start with the problem you need solved today.

CTA: **Choose a free tool**

Footer should repeat the privacy promise and contain only necessary navigation.

## Conversion requirements

- Communicate the category, privacy advantage and pricing model above the fold.
- Use one dominant CTA label consistently.
- Make every section reduce a specific objection: trust, capability, pricing, quality or relevance.
- Do not lead with Pro before establishing free value.
- Do not use countdowns, fake scarcity, fake reviews, exaggerated savings or dark patterns.
- Keep claims specific and defensible.
- Make the Pro offer feel like the obvious choice for a user with dozens of files, not a tax on casual users.

## SEO requirements

- Produce semantic HTML with one clear H1.
- Add a strong title and meta description.
- Add Open Graph title and description.
- Add appropriate `WebApplication` JSON-LD with free and $39 lifetime offer information.
- Use natural language around STL viewer, 3MF to STL, STL repair, OBJ/GLB conversion and G-code viewing without keyword stuffing.
- Keep the homepage genuinely useful and readable; do not generate thin programmatic SEO copy.
- Do not invent verified search volumes or keyword difficulty values in visible page content.

## Technical requirements

- Build with Astro and static output.
- Homepage route only: `src/pages/index.astro`.
- Use component-friendly, maintainable HTML and CSS even if the first version remains in one page file.
- No React, Vue or other client framework is needed.
- Use minimal JavaScript only for the mobile menu, sticky-header treatment and intersection-based reveal animation.
- Do not implement uploads, file selection, drag-and-drop, payments, authentication, API calls or backend routes.
- Keep all final assets local. Do not hotlink stock imagery.
- Use responsive layouts for desktop, tablet and mobile, with no horizontal overflow.
- Preserve keyboard navigation, visible focus states, a skip link, meaningful alt text and reduced-motion behavior.
- Use body text at 16px or larger and keep controls comfortably tappable on mobile.
- Ensure the project builds with `npm run build`.

## Deliverable

Return a complete Astro source project containing:

- `package.json`
- `astro.config.mjs`
- `tsconfig.json`
- `src/pages/index.astro`
- `src/styles/global.css`
- local hero artwork and favicon in `public/`
- `README.md` with local development and build steps

The result should feel like a credible, launch-ready homepage concept for a privacy-first 3D file utility—not a generic template and not a functioning file-processing application.
