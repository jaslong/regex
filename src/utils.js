import {Context, forEachUnescaped, replaceUnescaped} from 'regex-utilities';
import {Pattern, pattern} from './pattern.js';

export const RegexContext = {
  DEFAULT: 'R_DEFAULT',
  CHAR_CLASS: 'R_CHAR_CLASS',
  GROUP_NAME: 'R_GROUP_NAME',
  ENCLOSED_TOKEN: 'R_ENCLOSED_TOKEN',
  INTERVAL_QUANTIFIER: 'R_INTERVAL_QUANTIFIER',
  INVALID_INCOMPLETE_TOKEN: 'R_INVALID_INCOMPLETE_TOKEN',
};

export const CharClassContext = {
  DEFAULT: 'CC_DEFAULT',
  RANGE: 'CC_RANGE',
  ENCLOSED_TOKEN: 'CC_ENCLOSED_TOKEN',
  Q_TOKEN: 'CC_Q_TOKEN',
  INVALID_INCOMPLETE_TOKEN: 'CC_INVALID_INCOMPLETE_TOKEN',
};

export const patternModsSupported = (() => {
  try {
    new RegExp('(?i:)');
  } catch (e) {
    return false;
  }
  return true;
})();

export const flagVSupported = (() => {
  try {
    new RegExp('', 'v');
  } catch (e) {
    return false;
  }
  return true;
})();

export const doublePunctuatorChars = '&!#$%*+,.:;<=>?@^`~';

export const namedCapturingDelim = String.raw`\(\?<(?![=!])(?<captureName>[^>]+)>`;
export const capturingDelim = String.raw`\((?!\?)|${namedCapturingDelim}`;
export const noncapturingDelim = String.raw`\(\?(?:[:=!>A-Za-z\-]|<[=!]|\(DEFINE\))`;

/**
Escape special characters for the given context, assuming flag v.
@param {string} str String to escape
@param {'DEFAULT' | 'CHAR_CLASS'} context `Context` option from lib `regex-utilities`
@returns {string} Escaped string
*/
export function escapeV(str, context) {
  if (context === Context.CHAR_CLASS) {
    // Escape all double punctuators (including ^, which is special on its own in the first
    // position) in case they're bordered by the same character in or outside of the escaped string
    return str.replace(new RegExp(String.raw`[()\[\]{}|\\/\-${doublePunctuatorChars}]`, 'g'), '\\$&');
  }
  return str.replace(/[()\[\]{}|\\^$*+?.]/g, '\\$&');
}

// Sandbox without escaping by repeating the character and escaping only the first one. The second
// one is so that, if followed by the same symbol, the resulting double punctuator will still throw
// as expected. Details:
// - Only need to check the first position because, if it's part of an implicit union,
//   interpolation handling will wrap it in nested `[…]`.
// - Can't just wrap in nested `[…]` here, since the value might be used in a range.
// - Can't add a second unescaped symbol if a lone symbol is the entire string because it might be
//   followed by the same unescaped symbol outside an interpolation, and since it won't be wrapped,
//   the second symbol wouldn't be sandboxed from the one following it.
export function sandboxLoneDoublePunctuatorChar(str) {
  return str.replace(new RegExp(String.raw`^([${doublePunctuatorChars}])(?!\1)`), (m, _, pos) => {
    return `\\${m}${pos + 1 === str.length ? '' : m}`;
  });
}

// Sandbox `^` if relevant, done so it can't change the meaning of the surrounding character class
// if we happen to be at the first position. See `sandboxLoneDoublePunctuatorChar` for more details
export function sandboxLoneCharClassCaret(str) {
  return str.replace(/^\^/, '\\^^');
}

/**
Converts `\0` tokens to `\u{0}` in the given context.
@param {string} str
@param {'DEFAULT' | 'CHAR_CLASS'} [context] `Context` option from lib `regex-utilities`
@returns {string}
*/
export function sandboxUnsafeNulls(str, context) {
  // regex`[\0${0}]` and regex`[${pattern`\0`}0]` can't be guarded against via nested `[…]`
  // sandboxing in character classes if the interpolated value doesn't contain union (since it
  // might be placed on a range boundary). So escape `\0` in character classes as `\u{0}`
  return replaceUnescaped(str, String.raw`\\0(?!\d)`, '\\u{0}', context);
}

// No special handling for escaped versions of the characters
function getUnbalancedChar(expression, leftChar, rightChar) {
  let numOpen = 0;
  for (const [m] of expression.matchAll(new RegExp(`[${escapeV(leftChar + rightChar, Context.CHAR_CLASS)}]`, 'g'))) {
    numOpen += m === leftChar ? 1 : -1;
    if (numOpen < 0) {
      return rightChar;
    }
  }
  if (numOpen > 0) {
    return leftChar;
  }
  return '';
}

// Look for characters that would change the meaning of subsequent tokens outside an interpolated value
export function getBreakoutChar(expression, regexContext, charClassContext) {
  const escapesRemoved = expression.replace(/\\./gsu, '');
  // Trailing unescaped `\`; checking `.includes('\\')` would also work
  if (escapesRemoved.endsWith('\\')) {
    return '\\';
  }
  if (regexContext === RegexContext.DEFAULT) {
    // Unbalanced `[` or `]` are also errors but don't breakout; they're caught by the wrapper
    return getUnbalancedChar(escapesRemoved, '(', ')');
  } else if (
    regexContext === RegexContext.CHAR_CLASS &&
    !(charClassContext === CharClassContext.ENCLOSED_TOKEN || charClassContext === CharClassContext.Q_TOKEN)
  ) {
    return getUnbalancedChar(escapesRemoved, '[', ']');
  } else if (
    regexContext === RegexContext.ENCLOSED_TOKEN ||
    regexContext === RegexContext.INTERVAL_QUANTIFIER ||
    charClassContext === CharClassContext.ENCLOSED_TOKEN ||
    charClassContext === CharClassContext.Q_TOKEN
  ) {
    if (escapesRemoved.includes('}')) {
      return '}';
    }
  } else if (regexContext === RegexContext.GROUP_NAME) {
    if (escapesRemoved.includes('>')) {
      return '>';
    }
  }
  return '';
}

const contextToken = new RegExp(String.raw`
(?<groupN>\(\?<(?![=!])|\\[gk]<)
| (?<enclosedT>\\[pPu]\{)
| (?<qT>\\q\{)
| (?<intervalQ>\{)
| (?<incompleteT>\\(?: $
  | c(?![A-Za-z])
  | u(?![A-Fa-f\d]{4})[A-Fa-f\d]{0,3}
  | x(?![A-Fa-f\d]{2})[A-Fa-f\d]?
  )
)
| --
| \\?.
`.replace(/\s+/g, ''), 'gsu');

// Accepts and returns its full state so it doesn't have to reprocess parts that have already been
// seen. Assumes flag v and doesn't worry about syntax errors that are caught by it
export function getEndContextForIncompleteExpression(incompleteExpression, {
  regexContext = RegexContext.DEFAULT,
  charClassContext = CharClassContext.DEFAULT,
  charClassDepth = 0,
  lastPos = 0,
}) {
  contextToken.lastIndex = lastPos;
  let match;
  while (match = contextToken.exec(incompleteExpression)) {
    const {0: m, groups: {groupN, enclosedT, qT, intervalQ, incompleteT}} = match;
    if (m === '[') {
      charClassDepth++;
      regexContext = RegexContext.CHAR_CLASS;
      charClassContext = CharClassContext.DEFAULT;
    } else if (m === ']' && regexContext === RegexContext.CHAR_CLASS) {
      if (charClassDepth) {
        charClassDepth--;
      }
      if (!charClassDepth) {
        regexContext = RegexContext.DEFAULT;
      }
      charClassContext = CharClassContext.DEFAULT;
    } else if (regexContext === RegexContext.CHAR_CLASS) {
      if (incompleteT) {
        charClassContext = CharClassContext.INVALID_INCOMPLETE_TOKEN;
      } else if (m === '-') {
        charClassContext = CharClassContext.RANGE;
      } else if (enclosedT) {
        charClassContext = CharClassContext.ENCLOSED_TOKEN;
      } else if (qT) {
        charClassContext = CharClassContext.Q_TOKEN;
      } else if (
        (m === '}' && (charClassContext === CharClassContext.ENCLOSED_TOKEN || charClassContext === CharClassContext.Q_TOKEN)) ||
        // Don't continue in these contexts since we've advanced another token
        charClassContext === CharClassContext.INVALID_INCOMPLETE_TOKEN ||
        charClassContext === CharClassContext.RANGE
      ) {
        charClassContext = CharClassContext.DEFAULT;
      }
    } else {
      if (incompleteT) {
        regexContext = RegexContext.INVALID_INCOMPLETE_TOKEN;
      } else if (groupN) {
        regexContext = RegexContext.GROUP_NAME;
      } else if (enclosedT) {
        regexContext = RegexContext.ENCLOSED_TOKEN;
      } else if (intervalQ) {
        regexContext = RegexContext.INTERVAL_QUANTIFIER;
      } else if (
        (m === '>' && regexContext === RegexContext.GROUP_NAME) ||
        (m === '}' && (regexContext === RegexContext.ENCLOSED_TOKEN || regexContext === RegexContext.INTERVAL_QUANTIFIER)) ||
        // Don't continue in this context since we've advanced another token
        regexContext === RegexContext.INVALID_INCOMPLETE_TOKEN
       ) {
        regexContext = RegexContext.DEFAULT;
      }
    }
  }
  return {
    regexContext,
    charClassContext,
    charClassDepth,
    lastPos: incompleteExpression.length,
  };
}

/**
@param {string} expression
@returns {number}
*/
export function countCaptures(expression) {
  let num = 0;
  forEachUnescaped(expression, capturingDelim, () => num++, Context.DEFAULT);
  return num;
}

/**
@param {string} expression
@param {number} precedingCaptures
@returns {string}
*/
export function adjustNumberedBackrefs(expression, precedingCaptures) {
  return replaceUnescaped(
    expression,
    String.raw`\\(?<num>[1-9]\d*)`,
    ({groups: {num}}) => `\\${+num + precedingCaptures}`,
    Context.DEFAULT
  );
}

// Properties of strings as of ES2024
const stringPropertyNames = [
  'Basic_Emoji',
  'Emoji_Keycap_Sequence',
  'RGI_Emoji_Modifier_Sequence',
  'RGI_Emoji_Flag_Sequence',
  'RGI_Emoji_Tag_Sequence',
  'RGI_Emoji_ZWJ_Sequence',
  'RGI_Emoji',
].join('|');

const charClassUnionToken = new RegExp(String.raw`
\\(?: c[A-Za-z]
  | p\{(?<pStrProp>${stringPropertyNames})\}
  | [pP]\{[^\}]+\}
  | (?<qStrProp>q)
  | u(?:[A-Fa-f\d]{4}|\{[A-Fa-f\d]+\})
  | x[A-Fa-f\d]{2}
  | .
)
| --
| &&
| .
`.replace(/\s+/g, ''), 'gsu');

// Assumes flag v and doesn't worry about syntax errors that are caught by it
export function containsCharClassUnion(charClassPattern) {
  // Return `true` if it contains:
  // - `\p` (lowercase only) and the name is a property of strings (case sensitive).
  // - `\q`.
  // - Two single-char-matching tokens in sequence.
  // - One single-char-matching token followed immediately by unescaped `[`.
  // - One single-char-matching token preceded immediately by unescaped `]`.
  // Else, `false`.
  // Ranges with `-` create a single token.
  // Subtraction and intersection with `--` and `&&` create a single token.
  // Supports any number of nested classes
  let hasFirst = false;
  let lastM;
  for (const {0: m, groups} of charClassPattern.matchAll(charClassUnionToken)) {
    if (groups.pStrProp || groups.qStrProp) {
      return true;
    }
    if (m === '[' && hasFirst) {
      return true;
    }
    if (['-', '--', '&&'].includes(m)) {
      hasFirst = false;
    } else if (!['[', ']'].includes(m)) {
      if (hasFirst || lastM === ']') {
        return true;
      }
      hasFirst = true;
    }
    lastM = m;
  }
  return false;
}

/**
Returns transformed versions of a template and substitutions, using the given preprocessor. Only
processes substitutions that are instanceof `Pattern`.
@param {TemplateStringsArray} template
@param {any[]} substitutions
@param {(value, runningContext) => {transformed: string; runningContext: Object}} preprocessor
@returns {{template: TemplateStringsArray; substitutions: any[]}}
*/
export function preprocess(template, substitutions, preprocessor) {
  let newTemplate = {raw: []};
  let newSubstitutions = [];
  let runningContext = {};
  template.raw.forEach((raw, i) => {
    const result = preprocessor(raw, {...runningContext, lastPos: 0});
    newTemplate.raw.push(result.transformed);
    runningContext = result.runningContext;
    if (i < template.raw.length - 1) {
      const substitution = substitutions[i];
      if (substitution instanceof Pattern) {
        const result = preprocessor(substitution, {...runningContext, lastPos: 0});
        newSubstitutions.push(pattern(result.transformed));
        runningContext = result.runningContext;
      } else {
        newSubstitutions.push(substitution);
      }
    }
  });
  return {
    template: newTemplate,
    substitutions: newSubstitutions,
  };
}
