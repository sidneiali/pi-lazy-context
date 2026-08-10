function trimDescription(desc: unknown, maxChars: number, onTrim: (charsSaved: number) => void): unknown {
  if (typeof desc !== "string" || desc.length <= maxChars) return desc;
  onTrim(desc.length - maxChars);
  return `${desc.slice(0, maxChars)} […]`;
}

export function trimToolDescriptionsInPayload(
  payload: any,
  maxChars: number,
): { payload: any; trimmedCount: number; charsSaved: number } {
  if (!payload || !Array.isArray(payload.tools)) {
    return { payload, trimmedCount: 0, charsSaved: 0 };
  }

  let trimmedCount = 0;
  let charsSaved = 0;
  const onTrim = (n: number) => {
    trimmedCount++;
    charsSaved += n;
  };

  const newTools = payload.tools.map((tool: any) => {
    if (!tool || typeof tool !== "object") return tool;

    // Gemini-style: { functionDeclarations: [{ name, description, parameters }] }
    if (Array.isArray(tool.functionDeclarations)) {
      return {
        ...tool,
        functionDeclarations: tool.functionDeclarations.map((fd: any) =>
          fd && typeof fd.description === "string"
            ? { ...fd, description: trimDescription(fd.description, maxChars, onTrim) }
            : fd,
        ),
      };
    }

    // OpenAI-style nested: { type: "function", function: { name, description, parameters } }
    if (tool.function && typeof tool.function.description === "string") {
      return { ...tool, function: { ...tool.function, description: trimDescription(tool.function.description, maxChars, onTrim) } };
    }

    // Anthropic-style / OpenAI Responses flat: { name, description, input_schema|parameters }
    if (typeof tool.description === "string") {
      return { ...tool, description: trimDescription(tool.description, maxChars, onTrim) };
    }

    return tool; // shape nao reconhecido: nao mexe
  });

  return { payload: { ...payload, tools: newTools }, trimmedCount, charsSaved };
}

