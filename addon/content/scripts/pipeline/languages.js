/*
 * Language helpers for the reader pipeline:
 *  - DeepRead.PARSE_LANGUAGES / SOURCE_LANGUAGE_OPTIONS / FRANC_TO_SOURCE_LOCALE (copied verbatim)
 *  - DeepRead.detectLanguage(text): franc-compatible ISO 639-3 guess, "und" when undecidable.
 *
 * Ported from Vibero (AGPL-3.0, a Zotero fork): the constants above are copied verbatim from
 * parse_languages.js. detectLanguage is a local heuristic replacing franc({ minLength: 40 }).
 *
 * License: AGPL-3.0-or-later
 */
/* global DeepRead */

DeepRead.PARSE_LANGUAGES = {
  zh: {
    displayName: '简体中文',
    instruction: 'Simplified Chinese（简体中文）',
    nativeInstruction: '简体中文：所有摘要和翻译必须使用简体中文。',
    summaryTitles: {
      paperTitle: '论文标题',
      background: '研究背景与问题',
      innovations: '核心创新点',
      experiments: '实验结果',
      conclusions: '结论与价值'
    }
  },
  'zh-TW': {
    displayName: '繁體中文',
    instruction: 'Traditional Chinese（繁體中文）',
    nativeInstruction: '繁體中文：所有摘要和翻譯必須使用繁體中文。',
    summaryTitles: {
      paperTitle: '論文標題',
      background: '研究背景與問題',
      innovations: '核心創新點',
      experiments: '實驗結果',
      conclusions: '結論與價值'
    }
  },
  en: {
    displayName: 'English',
    instruction: 'English',
    nativeInstruction: '',
    summaryTitles: {
      paperTitle: 'Paper Title',
      background: 'Research Background',
      innovations: 'Core Innovations',
      experiments: 'Experimental Results',
      conclusions: 'Conclusions'
    }
  },
  ja: {
    displayName: '日本語',
    instruction: 'Japanese（日本語）',
    nativeInstruction: '日本語：すべての要約と翻訳は日本語で記述してください。',
    summaryTitles: {
      paperTitle: '論文タイトル',
      background: '研究背景',
      innovations: 'コアイノベーション',
      experiments: '実験結果',
      conclusions: '結論'
    }
  },
  ko: {
    displayName: '한국어',
    instruction: 'Korean（한국어）',
    nativeInstruction: '한국어: 모든 요약과 번역은 한국어로 작성해야 합니다.',
    summaryTitles: {
      paperTitle: '논문 제목',
      background: '연구 배경',
      innovations: '핵심 혁신',
      experiments: '실험 결과',
      conclusions: '결론'
    }
  },
  th: {
    displayName: 'ภาษาไทย',
    instruction: 'Thai（ภาษาไทย）',
    nativeInstruction: 'ภาษาไทย: สรุปและคำแปลทั้งหมดต้องเขียนเป็นภาษาไทย',
    summaryTitles: {
      paperTitle: 'ชื่อเรื่อง',
      background: 'พื้นหลังการวิจัย',
      innovations: 'นวัตกรรมหลัก',
      experiments: 'ผลการทดลอง',
      conclusions: 'บทสรุป'
    }
  },
  fr: {
    displayName: 'Français',
    instruction: 'French（Français）',
    nativeInstruction: 'Français: Tous les résumés et traductions doivent être rédigés en français.',
    summaryTitles: {
      paperTitle: "Titre de l'article",
      background: 'Contexte de la Recherche',
      innovations: 'Innovations Principales',
      experiments: 'Résultats Expérimentaux',
      conclusions: 'Conclusions'
    }
  },
  es: {
    displayName: 'Español',
    instruction: 'Spanish（Español）',
    nativeInstruction: 'Español: Todos los resúmenes y traducciones deben estar escritos en español.',
    summaryTitles: {
      paperTitle: 'Título del Artículo',
      background: 'Contexto de la Investigación',
      innovations: 'Innovaciones Principales',
      experiments: 'Resultados Experimentales',
      conclusions: 'Conclusiones'
    }
  },
  de: {
    displayName: 'Deutsch',
    instruction: 'German（Deutsch）',
    nativeInstruction: 'Deutsch: Alle Zusammenfassungen und Übersetzungen müssen auf Deutsch geschrieben werden.',
    summaryTitles: {
      paperTitle: 'Titel der Arbeit',
      background: 'Forschungshintergrund',
      innovations: 'Kerninnovationen',
      experiments: 'Experimentelle Ergebnisse',
      conclusions: 'Schlussfolgerungen'
    }
  }
};
DeepRead.SOURCE_LANGUAGE_OPTIONS = [{
  value: 'zh-CN',
  label: '简体中文'
}, {
  value: 'zh-TW',
  label: '繁體中文'
}, {
  value: 'en-US',
  label: 'English'
}, {
  value: 'ja-JP',
  label: '日本語'
}, {
  value: 'ko-KR',
  label: '한국어'
}, {
  value: 'th-TH',
  label: 'ภาษาไทย'
}, {
  value: 'fr-FR',
  label: 'Français'
}, {
  value: 'es-ES',
  label: 'Español'
}, {
  value: 'de-DE',
  label: 'Deutsch'
}, {
  value: 'ru-RU',
  label: 'Русский'
}, {
  value: 'ar',
  label: 'العربية'
}, {
  value: 'vi-VN',
  label: 'Tiếng Việt'
}, {
  value: 'pt-PT',
  label: 'Português'
}, {
  value: 'it-IT',
  label: 'Italiano'
}, {
  value: 'nl-NL',
  label: 'Nederlands'
}, {
  value: 'tr-TR',
  label: 'Türkçe'
}];
DeepRead.FRANC_TO_SOURCE_LOCALE = {
  cmn: 'zh-CN',
  zho: 'zh-CN',
  eng: 'en-US',
  jpn: 'ja-JP',
  kor: 'ko-KR',
  tha: 'th-TH',
  fra: 'fr-FR',
  spa: 'es-ES',
  deu: 'de-DE',
  rus: 'ru-RU',
  arb: 'ar',
  vie: 'vi-VN',
  por: 'pt-PT',
  ita: 'it-IT',
  nld: 'nl-NL',
  tur: 'tr-TR'
};

DeepRead.detectLanguage = (function () {
  const MIN_NON_SPACE_CHARS = 40;
  const LETTER_MAJORITY = 0.5;
  const KANA_MIN_RATIO = 0.05;
  const VI_MIN_COUNT = 3;
  const VI_MIN_RATIO = 0.02;

  const RE = {
    letter: /\p{L}/gu,
    word: /\p{L}+/gu,
    han: /\p{Script=Han}/gu,
    kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    hangul: /\p{Script=Hangul}/gu,
    thai: /\p{Script=Thai}/gu,
    cyrillic: /\p{Script=Cyrillic}/gu,
    arabic: /\p{Script=Arabic}/gu,
    latin: /\p{Script=Latin}/gu,
  };

  const VI_CHARS = new Set("ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ");

  // Common function words per language. Ambiguous words shared across languages are left out.
  const STOP_WORDS = {
    eng: new Set(["the", "and", "of", "to", "in", "is", "that", "it", "for", "with", "as", "was", "on", "are", "be", "this", "by", "from", "or", "which", "have", "has", "not", "we", "can"]),
    fra: new Set(["le", "la", "les", "et", "des", "est", "une", "du", "en", "que", "qui", "dans", "pour", "pas", "sur", "avec", "sont", "cette", "nous", "ce", "au", "aux", "ont"]),
    spa: new Set(["el", "los", "las", "y", "del", "es", "por", "para", "con", "una", "pero", "como", "más", "su", "sus", "al", "se", "son"]),
    deu: new Set(["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "zu", "mit", "den", "dem", "auf", "für", "sich", "auch", "von", "sind", "werden", "wird", "im"]),
    ita: new Set(["il", "di", "che", "è", "per", "non", "una", "sono", "con", "della", "gli", "anche", "come", "nel", "questo", "dei", "alla", "più"]),
    por: new Set(["de", "que", "o", "os", "do", "da", "em", "um", "uma", "para", "com", "não", "são", "na", "no", "dos", "das", "ao", "mais", "se", "é"]),
    nld: new Set(["het", "een", "van", "dat", "niet", "zijn", "op", "met", "voor", "ook", "als", "aan", "maar", "bij", "nog", "naar", "wordt", "deze"]),
    tur: new Set(["ve", "bir", "bu", "için", "ile", "çok", "olarak", "daha", "gibi", "ama", "olan", "şu", "değil", "her", "hem", "ancak"]),
  };

  function countMatches(re, str) {
    return (str.match(re) || []).length;
  }

  return function detectLanguage(text) {
    const str = typeof text === "string" ? text : String(text == null ? "" : text);
    if (str.replace(/\s+/g, "").length < MIN_NON_SPACE_CHARS) return "und";

    const letters = countMatches(RE.letter, str);
    if (!letters) return "und";
    const ratio = (n) => n / letters;

    // Han / kana: Japanese if kana is at least 5% of letters, otherwise Chinese.
    const han = countMatches(RE.han, str);
    const kana = countMatches(RE.kana, str);
    if (ratio(han + kana) > LETTER_MAJORITY) {
      return ratio(kana) >= KANA_MIN_RATIO ? "jpn" : "cmn";
    }
    if (ratio(countMatches(RE.hangul, str)) > LETTER_MAJORITY) return "kor";
    if (ratio(countMatches(RE.thai, str)) > LETTER_MAJORITY) return "tha";
    if (ratio(countMatches(RE.cyrillic, str)) > LETTER_MAJORITY) return "rus";
    if (ratio(countMatches(RE.arabic, str)) > LETTER_MAJORITY) return "arb";

    // Not predominantly Latin script and no supported script wins: undecidable.
    if (ratio(countMatches(RE.latin, str)) <= LETTER_MAJORITY) return "und";

    // Vietnamese by its diacritics.
    let vi = 0;
    for (const ch of str.toLowerCase()) {
      if (VI_CHARS.has(ch)) vi++;
    }
    if (vi >= VI_MIN_COUNT && ratio(vi) >= VI_MIN_RATIO) return "vie";

    // Latin languages by stop-word count; ties and zero scores fall back to English.
    const words = str.toLowerCase().match(RE.word) || [];
    let best = "eng";
    let bestScore = 0;
    for (const lang of Object.keys(STOP_WORDS)) {
      let score = 0;
      for (const w of words) {
        if (STOP_WORDS[lang].has(w)) score++;
      }
      if (score > bestScore) {
        best = lang;
        bestScore = score;
      }
    }
    return best;
  };
})();
