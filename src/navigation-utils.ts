import * as ts from 'typescript/lib/tsserverlibrary';

export interface ClickedWord {
  word: string;
  start: number;
  end: number;
  segmentIndex: number;
}

export interface NavigationPath {
  variableName: string;
  apiPath: string;
  segments: string[];
  clickedSegmentIndex: number;
  targetPath: string[];
}

/**
 * Finds the word at the given position in the text
 */
export function findWordAtPosition(text: string, position: number): ClickedWord {
  let wordStart = position;
  let wordEnd = position;

  // Find start of word
  while (wordStart > 0 && /\w/.test(text.charAt(wordStart - 1))) {
    wordStart--;
  }

  // Find end of word
  while (wordEnd < text.length && /\w/.test(text.charAt(wordEnd))) {
    wordEnd++;
  }

  const word = text.substring(wordStart, wordEnd);
  return { word, start: wordStart, end: wordEnd, segmentIndex: -1 };
}

/**
 * Parses a navigation path and determines which segment was clicked
 */
export function parseNavigationPath(
  fullPath: string,
  clickedWord: string,
  variableName: string,
): NavigationPath | null {
  const fullPathParts = fullPath.split('.');
  const apiPath = fullPathParts.slice(1).join('.');
  let clickedSegmentIndex = -1;

  // Find which segment was clicked
  for (let i = 0; i < fullPathParts.length; i++) {
    if (fullPathParts[i] === clickedWord) {
      clickedSegmentIndex = i;
      break;
    }
  }

  // Skip if clicked on variable name
  if (clickedSegmentIndex <= 0) {
    return null;
  }

  // Calculate target path (segments to navigate)
  const adjustedIndex = clickedSegmentIndex - 1; // Subtract 1 because apiPath doesn't include variable name
  const targetPath = apiPath.split('.').slice(0, adjustedIndex + 1);

  return {
    variableName,
    apiPath,
    segments: fullPathParts,
    clickedSegmentIndex,
    targetPath,
  };
}

/**
 * Creates a TypeScript DefinitionInfo result
 */
export function createDefinitionResult(
  fileName: string,
  start: number,
  length: number,
  name: string,
  kind: ts.ScriptElementKind = ts.ScriptElementKind.functionElement,
): ts.DefinitionInfo {
  return {
    fileName,
    textSpan: {
      start,
      length,
    },
    kind,
    name,
    containerKind: ts.ScriptElementKind.moduleElement,
    containerName: 'TRPC',
  };
}

/**
 * Creates a DefinitionInfoAndBoundSpan result
 */
export function createNavigationResult(
  definition: ts.DefinitionInfo,
  clickedWord: ClickedWord,
): ts.DefinitionInfoAndBoundSpan {
  return {
    definitions: [definition],
    textSpan: {
      start: clickedWord.start,
      length: clickedWord.word.length,
    },
  };
}

/**
 * Detects if a line contains a tRPC API call pattern
 */
export function detectTrpcApiCall(line: string, cursorPosition: number): { variable: string; path: string } | null {
  const beforeCursor = line.substring(0, cursorPosition);
  const afterCursor = line.substring(cursorPosition);

  // Match any variable followed by a dot and path
  const apiPattern = /(\w+)\s*\.\s*([\w.]*\w)?$/;
  const apiMatch = beforeCursor.match(apiPattern);

  if (!apiMatch) {
    return null;
  }

  const variable = apiMatch[1];
  let path = apiMatch[2] || '';

  // Look forward to complete the path until we hit:
  // - A method call: .something()
  // - End of property chain: whitespace, operators, or end of line
  const forwardMatch = afterCursor.match(/^([\w.]*?)(?=\s*(?:\.\s*\w+\s*\(|[^\w.]|$))/);

  if (forwardMatch?.[1]) {
    path += forwardMatch[1];
  }

  // Clean up the path
  path = path.replace(/\s+/g, '').replace(/\.+$/, '').replace(/^\.+/, '');

  return path ? { variable, path } : null;
}
