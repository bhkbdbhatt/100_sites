/**
 * 100-site batch fixture generator.
 *
 * The prompts are deliberately varied across industries, tones and required
 * sections so the batch exercises different compiler paths (pricing tables,
 * FAQs, contact forms, testimonials, galleries) rather than 100 copies of one
 * shape. Every prompt is written to stand alone: it must be enough for a model
 * to produce a usable site with no further context.
 *
 *   node scripts/gen-batch.mjs 100 > examples/batch-100.yaml
 */

const INDUSTRIES = [
  { slug: "dental", name: "Family Dental", trade: "dental practice", audience: "families in the area who want calm, predictable care", tone: "calm and reassuring" },
  { slug: "roastery", name: "Coffee Roasters", trade: "specialty coffee roastery", audience: "office managers who care about where beans come from", tone: "warm and editorial" },
  { slug: "plumbing", name: "Emergency Plumbing", trade: "emergency plumbing service", audience: "homeowners facing an urgent leak or blockage", tone: "direct and reassuring" },
  { slug: "studio", name: "Yoga Studio", trade: "yoga and breathwork studio", audience: "people recovering from burnout", tone: "quiet and grounding" },
  { slug: "sourdough", name: "Sourdough Bakery", trade: "wood-fired sourdough bakery", audience: "neighbourhood regulars who queue for the rye", tone: "plainspoken and proud" },
  { slug: "dental-lab", name: "Dental Lab", trade: "dental laboratory", audience: "practices that need lab work turned around on time", tone: "precise and technical" },
  { slug: "bikes", name: "Cycle Repair", trade: "bicycle repair and tuning", audience: "commuters who would rather fix than replace", tone: "practical and friendly" },
  { slug: "nursery", name: "Plant Nursery", trade: "independent plant nursery", audience: "gardeners restoring a neglected border", tone: "knowledgeable and unhurried" },
  { slug: "studio-arch", name: "Architecture Studio", trade: "residential architecture studio", audience: "homeowners planning a single significant build", tone: "restrained and precise" },
  { slug: "clinic", name: "Physiotherapy Clinic", trade: "physiotherapy clinic", audience: "people returning to sport after injury", tone: "encouraging and clinical" },
  { slug: "books", name: "Secondhand Books", trade: "secondhand bookshop", audience: "readers who like hunting rather than browsing", tone: "conversational" },
  { slug: "catering", name: "Wood-Fired Catering", trade: "wood-fired catering company", audience: "event organisers planning a long table", tone: "warm and practical" },
  { slug: "physio", name: "Sports Physiotherapy", trade: "sports physiotherapy practice", audience: "club athletes returning from injury", tone: "clinical and direct" },
  { slug: "gallery", name: "Print Gallery", trade: "photographic print gallery", audience: "interior designers sourcing large-format prints", tone: "quiet and visual" },
  { slug: "surveyors", name: "Building Surveyors", trade: "building survey practice", audience: "homebuyers who need to know what they are buying", tone: "precise and sober" },
  { slug: "tailoring", name: "Bespoke Tailoring", trade: "bespoke tailoring shop", audience: "people who want a suit that fits properly", tone: "traditional and exacting" },
  { slug: "gardens", name: "Garden Design", trade: "garden design studio", audience: "homeowners with an unusable garden", tone: "considered and seasonal" },
  { slug: "doula", name: "Birth Doula", trade: "birth doula practice", audience: "expectant parents planning a birth", tone: "gentle and non-judgemental" },
  { slug: "apothecary", name: "Herbal Apothecary", trade: "herbal apothecary", audience: "people making their own remedies", tone: "traditional and careful" },
  { slug: "repair", name: "Bike Repair Cooperative", trade: "bicycle repair cooperative", audience: "members who share tools and know-how", tone: "plain and communal" },
  { slug: "interiors", name: "Interior Design Studio", trade: "interior design studio", audience: "people who want a room that finally works", tone: "understated and warm" },
  { slug: "law", name: "Employment Law", trade: "employment law practice", audience: "employers dealing with a difficult dismissal", tone: "plain and firm" },
  { slug: "optician", name: "Independent Optician", trade: "independent optician", audience: "people tired of being upsold lenses", tone: "candid and practical" },
  { slug: "ceramics", name: "Ceramics Studio", trade: "community ceramics studio", audience: "beginners who want to make things with their hands", tone: "encouraging" },
  { slug: "locksmith", name: "Locksmith", trade: "locksmith and key service", audience: "people locked out at inconvenient hours", tone: "brief and competent" },
  { slug: "vineyard", name: "Small Vineyard", trade: "small vineyard and tasting room", audience: "visitors on a weekend afternoon", tone: "rural and specific" },
  { slug: "physio-clinic", name: "Pelvic Health Clinic", trade: "pelvic health clinic", audience: "people who have not been taken seriously before", tone: "respectful and specific" },
  { slug: "brewery", name: "Neighbourhood Brewery", trade: "neighbourhood brewery", audience: "locals after work and on weekends", tone: "unpretentious" },
  { slug: "tailor", name: "Costume Studio", trade: "theatrical costume studio", audience: "small theatre companies on a budget", tone: "collaborative" },
  { slug: "florist", name: "Wildflower Florist", trade: "seasonal flower shop", audience: "customers buying for occasions that matter", tone: "seasonal and warm" },
  { slug: "solar", name: "Solar Installers", trade: "residential solar installer", audience: "homeowners considering rooftop panels", tone: "plain and numeric" },
  { slug: "maker", name: "Woodworking School", trade: "woodworking school", audience: "beginners who want to make real furniture", tone: "instructional and patient" },
  { slug: "vet", name: "Mobile Veterinary", trade: "mobile veterinary service", audience: "pet owners whose animals hate travel", tone: "calm and practical" },
  { slug: "music", name: "Recording Studio", trade: "small recording studio", audience: "bands who want a real room", tone: "technical and friendly" },
  { slug: "translation", name: "Certified Translations", trade: "certified translation service", audience: "applicants who need documents accepted", tone: "precise and formal" },
  { slug: "sailing", name: "Sailing School", trade: "sailing school and club", audience: "adults learning to sail on weekends", tone: "encouraging and safety-first" },
  { slug: "sewing", name: "Alterations Studio", trade: "clothing alterations studio", audience: "people whose clothes never fit quite right", tone: "practical and kind" },
  { slug: "drama", name: "Drama School", trade: "part-time drama school", audience: "adults considering a first class", tone: "warm and unpretentious" },
  { slug: "landscape", name: "Landscape Gardening", trade: "landscape gardening contractor", audience: "homeowners who want the garden finished before summer", tone: "practical and seasonal" },
  { slug: "accountants", name: "Freelance Accountants", trade: "accountancy practice for freelancers", audience: "freelancers who have outgrown a spreadsheet", tone: "clear and calm" },
  { slug: "printshop", name: "Print Studio", trade: "risograph print studio", audience: "designers needing short runs", tone: "curious and precise" },
  { slug: "welding", name: "Fabrication Workshop", trade: "small fabrication workshop", audience: "builders who need a one-off metal part", tone: "blunt and capable" },
  { slug: "healing", name: "Sound Healing", trade: "sound and breathwork practitioner", audience: "people who find it hard to switch off", tone: "gentle and unhurried" },
  { slug: "caterers", name: "Street Food Kitchen", trade: "street food kitchen", audience: "market crowds at lunch", tone: "loud and friendly" },
  { slug: "photographer", name: "Documentary Photographer", trade: "documentary photographer", audience: "small charities needing a campaign image", tone: "observant" },
  { slug: "cobbler", name: "Cobbler", trade: "shoe repair cobbler", audience: "people who would rather repair than replace", tone: "craftsmanlike" },
  { slug: "swim", name: "Adult Swim School", trade: "adult swimming school", audience: "adults who never learned to swim", tone: "patient and unflappable" },
  { slug: "interpreter", name: "Community Interpreter", trade: "community interpreting service", audience: "clinicians and local authorities", tone: "discreet" },
  { slug: "electrician", name: "Domestic Electrician", trade: "certified domestic electrician", audience: "homeowners needing work done properly", tone: "plain and compliant" },
  { slug: "driving", name: "Driving School", trade: "driving school", audience: "learners who want to pass without anxiety", tone: "calm and encouraging" },
  { slug: "smith", name: "Blacksmith", trade: "blacksmith and repair work", audience: "farmers and gardeners with worn tools", tone: "laconic and competent" },
  { slug: "barber", name: "Barbershop", trade: "barbershop", audience: "regulars who want the same cut", tone: "easy and local" },
  { slug: "joinery", name: "Bespoke Joinery", trade: "bespoke joinery workshop", audience: "homeowners with awkward spaces", tone: "exact and unhurried" },
  { slug: "drycleaning", name: "Dry Cleaning", trade: "dry cleaning and alterations", audience: "people who want one shop for two jobs", tone: "unfussy" },
  { slug: "survey", name: "Party Surveyors", trade: "land surveyors", audience: "developers needing a definitive boundary", tone: "exact and neutral" },
  { slug: "glass", name: "Glassblowing Studio", trade: "glassblowing studio", audience: "people who want to make something with fire", tone: "craft-focused" },
  { slug: "antiques", name: "Antique Restorer", trade: "antique restoration workshop", audience: "people with inherited furniture", tone: "patient and historical" },
  { slug: "massage", name: "Sports Massage", trade: "sports massage clinic", audience: "runners training through injury", tone: "clinical and direct" },
  { slug: "kitchen", name: "Kitchen Design", trade: "kitchen design and joinery", audience: "families cooking every day", tone: "practical and warm" },
  { slug: "caterer", name: "Private Chef", trade: "private chef service", audience: "hosts cooking for a long table", tone: "discreet and warm" },
  { slug: "storage", name: "Self Storage", trade: "self storage facility", audience: "people between homes or renovations", tone: "plain and reassuring" },
  { slug: "cleaners", name: "Domestic Cleaning", trade: "domestic cleaning agency", audience: "households who want their time back", tone: "reliable and plain" },
  { slug: "climbing", name: "Indoor Climbing Centre", trade: "indoor climbing centre", audience: "beginners and experienced climbers", tone: "energetic" },
  { slug: "chiropody", name: "Foot Care Clinic", trade: "foot care clinic", audience: "people who struggle to reach their own feet", tone: "gentle and unhurried" },
  { slug: "language", name: "Language Courses", trade: "evening language courses", audience: "adults starting from zero", tone: "encouraging" },
  { slug: "pottery", name: "Pottery Studio", trade: "pottery studio", audience: "people who want to spend two hours with clay", tone: "calm" },
  { slug: "seamstress", name: "Home Dressmaker", trade: "home dressmaking service", audience: "women who want clothes fitted properly", tone: "personal" },
  { slug: "security", name: "Home Security", trade: "home security installer", audience: "households on a street that has had a break-in", tone: "reassuring" },
  { slug: "solar-roof", name: "Roofing", trade: "roofing contractor", audience: "homeowners with a leak they cannot locate", tone: "plain and factual" },
  { slug: "hair", name: "Colour Studio", trade: "hair colour studio", audience: "people who have been given the wrong shade before", tone: "consultative" },
  { slug: "notary", name: "Notary Public", trade: "mobile notary service", audience: "people who need a signature witnessed", tone: "formal and brief" },
  { slug: "landscaping", name: "Tree Care", trade: "tree surgery and care", audience: "homeowners worried about a large tree", tone: "safety-led" },
  { slug: "halls", name: "Village Hall", trade: "village hall hire", audience: "groups organising a one-day event", tone: "community-minded" },
  { slug: "museum", name: "Local Museum", trade: "small local museum", audience: "visitors with an hour and a school-age child", tone: "informative and warm" },
  { slug: "radio", name: "Community Radio", trade: "community radio station", audience: "listeners who want local voices", tone: "conversational" },
  { slug: "tailoress", name: "Bridal Alterations", trade: "bridal alterations service", audience: "brides with a dress that needs work", tone: "reassuring and discreet" },
  { slug: "sculptor", name: "Stone Sculptor", trade: "stone sculpture workshop", audience: "gardeners and memorial families", tone: "quiet and craft-focused" },
  { slug: "electric", name: "EV Charging Installers", trade: "EV charging installation", audience: "homeowners without a driveway", tone: "practical" },
  { slug: "bikehire", name: "Cycle Hire", trade: "cycle hire and servicing", audience: "visitors and commuters", tone: "brisk" },
  { slug: "frame", name: "Picture Framing", trade: "picture framing workshop", audience: "people with one print worth framing properly", tone: "craft-focused" },
  { slug: "cashmere", name: "Knitwear Repair", trade: "knitwear repair service", audience: "people with a favourite jumper", tone: "gentle" },
  { slug: "bespoke", name: "Bespoke Jewellery", trade: "bespoke jewellery workshop", audience: "people marking a significant occasion", tone: "personal and precise" },
  { slug: "teaching", name: "Music Lessons", trade: "private music lessons", audience: "children and adults learning an instrument", tone: "patient" },
  { slug: "wine", name: "Wine Merchants", trade: "small wine merchants", audience: "people buying for a dinner party", tone: "unpretentious" },
  { slug: "moving", name: "Removals Company", trade: "house removals company", audience: "families moving between cities", tone: "plain and organised" },
  { slug: "gardener", name: "Garden Maintenance", trade: "garden maintenance contractor", audience: "people who want their garden kept", tone: "seasonal" },
  { slug: "press", name: "Letterpress Studio", trade: "letterpress print studio", audience: "designers and small businesses", tone: "craft-obsessed" },
  { slug: "petcare", name: "Pet Boarding", trade: "pet boarding and day care", audience: "owners whose pets do not cope alone", tone: "warm" },
  { slug: "electrician2", name: "EV Repair", trade: "e-bike repair", audience: "commuters with a bike that has stopped", tone: "practical" },
];

const SECTION_SETS = [
  ["pricing", "faq", "contact"],
  ["services", "about", "faq", "contact"],
  ["pricing", "about", "contact"],
  ["services", "faq", "contact"],
  ["about", "team", "faq", "contact"],
  ["services", "pricing", "faq", "contact"],
];

function pick(list, index) {
  return list[index % list.length];
}

const count = Number(process.argv[2] ?? 100);

const lines = [
  "# 100-site batch fixture.",
  "# Generated by scripts/gen-batch.mjs. Vary --count for smaller runs.",
  "batch_id: batch-100-2026",
  "tenant: default",
  "template: astro-nano",
  "",
  "policies:",
  "  max_attempts: 3",
  "  retry_backoff_ms: [500, 2000, 8000]",
  "  site_timeout_ms: 120000",
  "  deadline_ms: 5400000",
  "  fail_policy: continue",
  "  fallback_enabled: true",
  "",
  "concurrency:",
  "  max_parallel_builds: 8",
  "  max_parallel_compiles: 8",
  "  per_build_memory_mb: 384",
  "",
  "output:",
  "  dest: out/100",
  "  artifact_store: cas",
  "  report_formats: [json, csv, markdown]",
  "",
  "liveness:",
  "  provider: deterministic",
  "  max_cost_usd: 25",
  "",
  "build:",
  "  ssg: static",
  "  asset_resolver: placeholder",
  "",
  "prompts:",
];

for (let i = 0; i < count; i += 1) {
  const industry = pick(INDUSTRIES, i);
  const sections = pick(SECTION_SETS, i);
  const prompt = [
    `${industry.name}, a ${industry.trade}`,
    `for ${industry.audience}.`,
    `${industry.tone[0].toUpperCase()}${industry.tone.slice(1)} tone.`,
    `Include ${sections.join(", ")} sections,`,
    `and a homepage with a hero, three key benefits and clear calls to action.`,
  ].join(" ");

  lines.push(`  - site_id: ${industry.slug}${i < INDUSTRIES.length ? "" : `-${i + 1}`}`);
  lines.push(`    prompt: >-`);
  lines.push(`      ${prompt}`);
  lines.push(`    constraints:`);
  lines.push(`      template: astro-nano`);
  lines.push(`      max_pages: ${(i % 3) + 6}`);
  lines.push(`      required_sections: [${sections.map((s) => `"${s}"`).join(", ")}]`);
  lines.push("");
}

process.stdout.write(lines.join("\n"));
