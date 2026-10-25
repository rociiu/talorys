import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown";

const label = (lang: string) => {
  const html = renderToStaticMarkup(createElement(Markdown, { content: `\`\`\`${lang}\nx\n\`\`\`` }));
  return /<span class="[^"]*uppercase[^"]*">([^<]*)<\/span>/.exec(html)?.[1];
};

describe("code block language label", () => {
  it("shows the whole language name", () => {
    expect(label("c++")).toBe("c++");
    expect(label("c#")).toBe("c#");
    expect(label("objective-c")).toBe("objective-c");
    expect(label("js")).toBe("js");
  });
});
