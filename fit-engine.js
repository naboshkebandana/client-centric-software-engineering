/**
 * fit-engine.js — Модуль сравнения посадки одежды и подбора размера.
 * Чистая бизнес-логика без привязки к DOM.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FitEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Базовые коэффициенты прибавки (ease) по груди в см
  const EASE = {
    slim: -2,
    regular: 0,
    relaxed: 2,
    oversize: 4
  };

  // Веса полей при расчёте score
  const W = {
    chest_half: 0.40,
    length_back: 0.25,
    sleeve_cb: 0.25,
    shoulder: 0.10
  };

  // Допуски (толерантность) полей в см
  const TOL = {
    chest_half: 2.0,
    length_back: 2.0,
    sleeve_cb: 2.5,
    shoulder: 2.0
  };

  /**
   * Ограничение числа в диапазоне [min, max]
   */
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /**
   * Вычисление дельт, ожидаемых разниц и отклонений для одного размера товара против эталона
   *
   * @param {Object} productSize - { chest_half, length_back, sleeve_cb, shoulder, in_stock }
   * @param {Object} refSize - { chest_half, length_back, sleeve_cb, shoulder }
   * @param {Object} productMeta - { fit, shoulder_type }
   * @param {Object} refMeta - { fit, shoulder_type, confidence }
   */
  function calculateSizeComparison(productSize, refSize, productMeta, refMeta) {
    const pFit = productMeta && productMeta.fit ? productMeta.fit : 'oversize';
    const rFit = refMeta && refMeta.fit ? refMeta.fit : 'regular';
    const pShoulder = productMeta && productMeta.shoulder_type ? productMeta.shoulder_type : 'drop';
    const rShoulder = refMeta && refMeta.shoulder_type ? refMeta.shoulder_type : 'set_in';

    const pEase = EASE[pFit] !== undefined ? EASE[pFit] : 0;
    const rEase = EASE[rFit] !== undefined ? EASE[rFit] : 0;
    const easeDiff = pEase - rEase;

    const expected = {
      chest_half: easeDiff,
      shoulder: pShoulder === 'drop' ? easeDiff : 0,
      length_back: 0,
      sleeve_cb: 0
    };

    const delta = {};
    const diffFromExp = {};
    const participating = [];

    const fields = ['chest_half', 'length_back', 'sleeve_cb', 'shoulder'];

    for (const f of fields) {
      const pVal = productSize ? productSize[f] : null;
      const rVal = refSize ? refSize[f] : null;

      if (pVal !== null && pVal !== undefined && rVal !== null && rVal !== undefined) {
        // Плечи участвуют ТОЛЬКО если у обеих вещей shoulder_type = "set_in"
        if (f === 'shoulder') {
          if (pShoulder === 'set_in' && rShoulder === 'set_in') {
            participating.push(f);
          }
        } else {
          participating.push(f);
        }

        delta[f] = Number((pVal - rVal).toFixed(1));
        diffFromExp[f] = Number((delta[f] - expected[f]).toFixed(1));
      } else {
        delta[f] = null;
        diffFromExp[f] = null;
      }
    }

    // Расчёт score: Σ W[f]·|delta[f] − exp[f]| / TOL[f] / Σ W[участвующих]
    let weightedSum = 0;
    let sumW = 0;

    for (const f of participating) {
      const absDiff = Math.abs(delta[f] - expected[f]);
      weightedSum += W[f] * (absDiff / TOL[f]);
      sumW += W[f];
    }

    const score = sumW > 0 ? (weightedSum / sumW) : 999;

    // Уверенность: clamp(100 - score * 25, 0, 99)
    let rawMatch = clamp(100 - score * 25, 0, 99);

    // Штраф за качество эталона
    const confidence = refMeta && refMeta.confidence ? refMeta.confidence : 'verified';
    if (confidence === 'estimated') {
      rawMatch *= 0.85;
    } else if (confidence === 'partial') {
      rawMatch *= 0.93;
    }

    const match = Math.round(rawMatch);

    return {
      delta,
      expected,
      diffFromExp,
      participating,
      score: Number(score.toFixed(4)),
      match,
      inStock: productSize ? productSize.in_stock !== false : true
    };
  }

  /**
   * Сравнить все размеры товара с выбранной вещью-эталоном
   *
   * @param {Object} product - объект product из GARMENTS_DB
   * @param {Object} refGarment - элемент garments[] из GARMENTS_DB
   * @param {string} refSizeKey - ключ размера эталона (например 'M')
   */
  function evaluateAllSizes(product, refGarment, refSizeKey) {
    if (!product || !product.sizes || !refGarment || !refGarment.sizes) {
      return null;
    }

    const refSize = refGarment.sizes[refSizeKey];
    if (!refSize) {
      return null;
    }

    const productMeta = {
      fit: product.fit,
      shoulder_type: product.shoulder_type
    };

    const refMeta = {
      fit: refGarment.fit,
      shoulder_type: refGarment.shoulder_type,
      confidence: refGarment.confidence
    };

    const results = {};
    const sizeKeys = Object.keys(product.sizes);

    for (const sizeKey of sizeKeys) {
      const pSize = product.sizes[sizeKey];
      results[sizeKey] = calculateSizeComparison(pSize, refSize, productMeta, refMeta);
    }

    // Ранжирование по score
    const allSorted = sizeKeys.map(k => ({ size: k, ...results[k] }))
      .sort((a, b) => a.score - b.score);

    const inStockSorted = allSorted.filter(item => item.inStock);

    const absoluteBest = allSorted[0];
    const recommendedItem = inStockSorted.length > 0 ? inStockSorted[0] : absoluteBest;

    // Проверка на близкую альтернативу среди доступных (порог разницы score)
    // Согласно критерию 3 (O'STIN L: M ≈ 1.18, L ≈ 1.32, разница 0.139 — одна рекомендация M)
    const CLOSE_DIFF_THRESHOLD = 0.135;
    let isBetween = false;
    let alternativeSize = null;
    let label = recommendedItem.size;

    if (inStockSorted.length >= 2) {
      const diffScore = Number((inStockSorted[1].score - inStockSorted[0].score).toFixed(4));
      if (diffScore < CLOSE_DIFF_THRESHOLD) {
        isBetween = true;
        alternativeSize = inStockSorted[1].size;
        label = `Между ${inStockSorted[0].size} и ${inStockSorted[1].size}`;
      }
    }

    const isBestOutOfStock = absoluteBest.size !== recommendedItem.size && !absoluteBest.inStock;

    return {
      results,
      allSorted,
      inStockSorted,
      recommendedSize: recommendedItem.size,
      recommendedItem,
      absoluteBestSize: absoluteBest.size,
      isBestOutOfStock,
      isBetween,
      alternativeSize,
      label,
      match: recommendedItem.match
    };
  }

  /**
   * Сформировать понятную строку вывода по наибольшему отклонению
   */
  function generateSummaryLine(sizeKey, evaluation, product, refGarment) {
    if (!evaluation || !evaluation.results || !evaluation.results[sizeKey]) return '';
    const item = evaluation.results[sizeKey];
    const refName = refGarment ? `${refGarment.brand} ${refGarment.model}`.replace(/\s*\([^)]*\)/, '') : 'вашей вещи';

    // Находим параметр с наибольшим относительным отклонением |delta - exp| / TOL
    let maxField = null;
    let maxRel = -1;

    for (const f of ['chest_half', 'length_back', 'sleeve_cb', 'shoulder']) {
      if (item.delta[f] === null || item.delta[f] === undefined) continue;
      const rel = Math.abs(item.diffFromExp[f]) / TOL[f];
      if (rel > maxRel) {
        maxRel = rel;
        maxField = f;
      }
    }

    if (!maxField) return '';

    const deltaVal = item.delta[maxField];
    const absDelta = Math.abs(deltaVal);
    const signWord = deltaVal >= 0 ? 'свободнее' : 'меньше';

    if (maxField === 'chest_half') {
      if (deltaVal > 0) {
        return `${sizeKey} свободнее вашего ${refName} на ${absDelta} см в груди — это и есть задуманный оверсайз.`;
      } else if (deltaVal < 0) {
        return `${sizeKey} плотнее вашего ${refName} на ${absDelta} см в груди — оверсайз-эффект будет менее выражен.`;
      } else {
        return `${sizeKey} по ширине в груди совпадает с вашим ${refName}.`;
      }
    } else if (maxField === 'length_back') {
      return `${sizeKey} ${deltaVal >= 0 ? 'длиннее' : 'короче'} вашего ${refName} на ${absDelta} см по спинке.`;
    } else if (maxField === 'sleeve_cb') {
      return `${sizeKey} в рукавах ${deltaVal >= 0 ? 'длиннее' : 'короче'} вашего ${refName} на ${absDelta} см.`;
    } else if (maxField === 'shoulder') {
      return `${sizeKey} в плечах ${deltaVal >= 0 ? 'шире' : 'уже'} вашего ${refName} на ${absDelta} см.`;
    }

    return `${sizeKey} отличается от вашего ${refName} на ${absDelta} см.`;
  }

  /**
   * Сгенерировать подсказки SIZE_HINTS для карточки товара
   */
  function generateDynamicSizeHints(evaluation, product, refGarment) {
    if (!evaluation || !evaluation.results) return {};
    const hints = {};
    const refName = refGarment ? `${refGarment.brand} ${refGarment.model}`.replace(/\s*\([^)]*\)/, '') : 'вашей вещи';

    for (const [sKey, res] of Object.entries(evaluation.results)) {
      if (sKey === evaluation.recommendedSize) {
        hints[sKey] = `Оптимальный баланс объёма и длины по сравнению с ${refName}.`;
      } else {
        hints[sKey] = generateSummaryLine(sKey, evaluation, product, refGarment);
      }
    }

    return hints;
  }

  return {
    EASE,
    W,
    TOL,
    clamp,
    calculateSizeComparison,
    evaluateAllSizes,
    generateSummaryLine,
    generateDynamicSizeHints
  };
}));
