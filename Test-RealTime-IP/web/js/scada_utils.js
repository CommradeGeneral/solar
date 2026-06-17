/*
 * SCADA shared utilities
 * Reusable helpers that must preserve DOM children while updating values.
 */

(function () {
    window.SCADA_UTILS = window.SCADA_UTILS || {};

    window.SCADA_UTILS.setTextPreservingChildren = function (element, value, options = {}) {
        const target = typeof element === 'string' ? document.querySelector(element) : element;
        if (!target) return false;

        const text = value === null || value === undefined ? '' : String(value);
        const valueSelector = options.valueSelector || '[data-scada-value="true"]';
        const valueNode = target.querySelector ? target.querySelector(valueSelector) : null;

        if (valueNode) {
            valueNode.textContent = text;
            return true;
        }

        const firstTextNode = Array.from(target.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
        if (firstTextNode) {
            firstTextNode.nodeValue = text;
            return true;
        }

        if (target.children && target.children.length > 0) {
            target.insertBefore(document.createTextNode(text), target.firstChild);
            return true;
        }

        target.textContent = text;
        return true;
    };
})();
