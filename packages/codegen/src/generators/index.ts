import type { SnippetGenerator, SnippetLanguage } from '../types';
import { generateCSharp } from './csharp';
import { generateCurl } from './curl';
import { generateGo } from './go';
import { generateHttp } from './http';
import { generateHttpie } from './httpie';
import { generateJava } from './java';
import { generateJavaScriptFetch, generateNodeFetch } from './javascript';
import { generatePhpCurl } from './php';
import { generatePowerShell } from './powershell';
import { generatePythonRequests } from './python';
import { generateRuby } from './ruby';

export const GENERATORS: Record<SnippetLanguage, SnippetGenerator> = {
  curl: generateCurl,
  http: generateHttp,
  'javascript-fetch': generateJavaScriptFetch,
  'node-fetch': generateNodeFetch,
  'python-requests': generatePythonRequests,
  powershell: generatePowerShell,
  go: generateGo,
  java: generateJava,
  csharp: generateCSharp,
  'php-curl': generatePhpCurl,
  ruby: generateRuby,
  httpie: generateHttpie,
};
