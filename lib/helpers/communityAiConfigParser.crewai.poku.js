import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

import { assert, describe, it } from "poku";

import { communityAiConfigParser } from "./communityAiConfigParser.js";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("communityAiConfigParser CrewAI Python modules", () => {
  const fixtures = resolve(
    import.meta.dirname,
    "..",
    "..",
    "test",
    "data",
    "crewai",
  );

  function crewSummary(files) {
    return communityAiConfigParser
      .parse(files.map((file) => join(fixtures, file)))
      .components.map((component) => ({
        name: component.name,
        properties: Object.fromEntries(
          component.properties
            .filter((property) => property.name.startsWith("cdx:crewai:"))
            .map((property) => [
              property.name.replace("cdx:crewai:", ""),
              property.value,
            ]),
        ),
        role: getProp(component, "cdx:agent:role"),
      }));
  }

  it("reads each agent from the function that returns it", () => {
    assert.deepStrictEqual(crewSummary(["classic/agents.py"]), [
      {
        name: "city_selection_agent",
        properties: {
          backstory:
            "An expert in analyzing travel data to pick ideal destinations",
          goal: "Select the best city based on weather, season, and prices",
          role: "City Selection Expert",
          tools: "SearchTools.search_internet,SearchTools.search_news",
        },
        role: "crew-agent",
      },
      {
        name: "local_expert",
        properties: {
          backstory:
            "A knowledgeable local guide with extensive information about the city, its attractions and customs",
          goal: "Provide the BEST insights about the selected city",
          role: "Local Expert at this city",
          tools: "SearchTools.search_internet",
        },
        role: "crew-agent",
      },
      {
        // helper() returns a string, so the next function's agent is not
        // attributed to it.
        name: "travel_concierge",
        properties: {
          backstory: "Specialist in travel planning and logistics",
          goal: "Create the most amazing travel itineraries with budget and packing suggestions for the city",
          role: "Amazing Travel Concierge",
          tools: "SearchTools.search_internet,CalculatorTools.calculate",
        },
        role: "crew-agent",
      },
    ]);
  });

  it("reads task descriptions written as dedented f-strings", () => {
    assert.deepStrictEqual(crewSummary(["classic/tasks.py"]), [
      {
        name: "identify_task",
        properties: {
          description:
            "Analyze and select the best city for the trip based on specific criteria such as weather patterns. Traveling from: {origin}",
          expectedOutput: "A detailed report on the chosen city",
        },
        role: "crew-task",
      },
      {
        name: "gather_task",
        properties: {
          description: "Compile an in-depth guide for the selected city",
          expectedOutput: "A comprehensive city guide",
        },
        role: "crew-task",
      },
    ]);
  });

  it("reads annotated and decorated agent methods", () => {
    assert.deepStrictEqual(crewSummary(["decorated/agents.py"]), [
      {
        name: "researcher",
        properties: {
          role: 'Senior "Data" Researcher',
          tools: "SerperDevTool()",
        },
        role: "crew-agent",
      },
      {
        name: "reporting_analyst",
        properties: {
          goal: "Turn findings into reports",
          role: "Reporting Analyst",
        },
        role: "crew-agent",
      },
    ]);
  });

  it("ignores lines inside strings and comments that look like code", () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-crewai-"));
    try {
      const file = join(tmpDir, "agents.py");
      writeFileSync(
        file,
        [
          "from crewai import Agent",
          "",
          "def writer():",
          "    # return Agent(role='commented out')",
          '    return Agent(role="Writer", backstory="""',
          "def not_a_function():",
          "    return Agent(role='inside a string')",
          '""", goal="Write")',
          "",
        ].join("\n"),
      );
      const { components } = communityAiConfigParser.parse([file]);
      assert.deepStrictEqual(
        components.map((component) => [
          component.name,
          getProp(component, "cdx:crewai:role"),
          getProp(component, "cdx:crewai:goal"),
        ]),
        [["writer", "Writer", "Write"]],
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("parses crafted modules in time proportional to their size", () => {
    // A parser whose work grows with the square of its input needs seconds
    // for each of these, and a linear one milliseconds, so the bound leaves
    // room for slow runners.
    const tmpDir = mkdtempSync(join(os.tmpdir(), "cdxgen-crewai-size-"));
    const header = "from crewai import Agent\n";
    const body = "def a():\n    return Agent(\n";
    const inputs = {
      "definitions without a returned agent": `${header}${"def x():\n".repeat(128000)}`,
      "dedent calls without a string": `${header}${body}${"role=dedent(".repeat(40000)}\n)\n`,
      "tool lists that never close": `${header}${body}${"tools=[".repeat(40000)}\n)\n`,
      "returned calls that never close": `${header}${"def x():\n return Agent(\n".repeat(64000)}`,
    };
    try {
      const file = join(tmpDir, "agents.py");
      for (const [shape, raw] of Object.entries(inputs)) {
        writeFileSync(file, raw);
        const started = performance.now();
        communityAiConfigParser.parse([file]);
        const elapsed = performance.now() - started;
        assert.ok(
          elapsed < 1500,
          `${shape} (${raw.length} bytes) took ${Math.round(elapsed)} ms`,
        );
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
