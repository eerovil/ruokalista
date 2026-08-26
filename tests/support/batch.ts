export const AGENTDECK_BATCH = {
  format_version: 1,
  generator: {
    via: "agentdeck",
    provider: "codex",
    model: "gpt-5.6",
  },
  recipes: [
    {
      title: "AgentDeck-keitto",
      yield_portions: 4,
      source_text: [
        "AgentDeck-keitto",
        "1 l vettä",
        "2 dl kikherneitä",
        "Keitä aineksia 15 minuuttia.",
      ].join("\n"),
      lines: [
        line({
          quantity: 1,
          unit: "l",
          ingredient_name: "vesi",
          source_line: "1 l vettä",
          note: "Veden lämpötilaa ei kerrottu.",
        }),
        line({ quantity: 2, unit: "dl", ingredient_name: "kikherne", source_line: "2 dl kikherneitä" }),
      ],
      steps: [step({ text: "Keitä aineksia 15 minuuttia." })],
    },
    {
      title: "AgentDeck-piirakka",
      yield_portions: 6,
      source_text: [
        "AgentDeck-piirakka",
        "1 rkl öljyä",
        "Täyte",
        "3 dl kikherneitä",
        "1 dl juustoa",
        "Voitele vuoka.",
        "Soseuta täyte.",
        "Kokoa piirakka ja paista.",
      ].join("\n"),
      lines: [
        line({ quantity: 1, unit: "rkl", ingredient_name: "öljy", source_line: "1 rkl öljyä", phase: "before_parts" }),
        line({ quantity: 3, unit: "dl", ingredient_name: "kikherne", source_line: "3 dl kikherneitä", section: " Täyte " }),
        line({ quantity: 1, unit: "dl", ingredient_name: "juusto", source_line: "1 dl juustoa", phase: "after_parts" }),
      ],
      steps: [
        step({ text: "Voitele vuoka.", phase: "before_parts" }),
        step({ text: "Soseuta täyte.", section: "Täyte" }),
        step({ text: "Kokoa piirakka ja paista.", phase: "after_parts" }),
      ],
    },
  ],
};

function line(overrides: Record<string, unknown>) {
  return {
    quantity: null,
    quantity_max: null,
    unit: null,
    alt_quantity: null,
    alt_unit: null,
    ingredient_id: null,
    ingredient_name: "",
    source_line: "",
    section: null,
    phase: null,
    note: null,
    ...overrides,
  };
}

function step(overrides: Record<string, unknown>) {
  return { text: "", section: null, phase: null, ...overrides };
}

export function batchCopy(): typeof AGENTDECK_BATCH {
  return JSON.parse(JSON.stringify(AGENTDECK_BATCH)) as typeof AGENTDECK_BATCH;
}
