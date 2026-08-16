// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The machine's controls, as custom elements.
//
// All of them render into light DOM: one stylesheet governs the whole panel,
// and native <input> does the accessibility work wherever it can.

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function formatValue(value, { decimals, unit, scale, format }) {
  // Zoom is stored as log2 so the fader travels evenly, but nobody thinks in
  // octaves, so show it as a percentage.
  if (format === 'log2pct') {
    const pct = 2 ** value * 100;
    return `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`;
  }
  const shown = value * scale;
  const text = decimals > 0 ? shown.toFixed(decimals) : String(Math.round(shown));
  return unit ? `${text}${unit}` : text;
}

/**
 * <ink-fader label min max step value decimals unit scale>
 * A range input dressed as a machine fader, with a live readout.
 */
class InkFader extends HTMLElement {
  connectedCallback() {
    if (this.rendered) return;
    this.rendered = true;

    this.min = num(this.getAttribute('min'), 0);
    this.max = num(this.getAttribute('max'), 1);
    this.step = num(this.getAttribute('step'), 0.01);
    this.decimals = num(this.getAttribute('decimals'), 2);
    this.unit = this.getAttribute('unit') || '';
    this.scale = num(this.getAttribute('scale'), 1);
    this.format = this.getAttribute('format') || '';
    this.defaultValue = num(this.getAttribute('value'), 0);

    const id = this.id ? `${this.id}-input` : '';
    this.innerHTML = `
      <div class="fader">
        <div class="fader__head">
          <label class="fader__label"${id ? ` for="${id}"` : ''}>${this.getAttribute('label') || ''}</label>
          <output class="fader__value"></output>
        </div>
        <input class="fader__slider" type="range"${id ? ` id="${id}"` : ''}
               min="${this.min}" max="${this.max}" step="${this.step}" value="${this.defaultValue}">
      </div>`;

    this.input = this.querySelector('input');
    this.output = this.querySelector('output');
    this.input.addEventListener('input', () => this.sync());
    this.sync();
  }

  sync() {
    this.output.textContent = formatValue(this.value, this);
    const pct = ((this.value - this.min) / (this.max - this.min)) * 100;
    this.style.setProperty('--fill', `${pct}%`);
  }

  get value() {
    return num(this.input?.value, this.defaultValue);
  }

  set value(v) {
    if (!this.input) return;
    this.input.value = String(v);
    this.sync();
  }

  reset() {
    this.value = this.defaultValue;
  }
}

/**
 * <ink-dial label min max step value unit detent>
 * A rotary control. Grab and turn it, or drag vertically for fine work.
 */
class InkDial extends HTMLElement {
  connectedCallback() {
    if (this.rendered) return;
    this.rendered = true;

    this.min = num(this.getAttribute('min'), -180);
    this.max = num(this.getAttribute('max'), 180);
    this.step = num(this.getAttribute('step'), 0.5);
    this.decimals = num(this.getAttribute('decimals'), 1);
    this.unit = this.getAttribute('unit') || '';
    this.scale = 1;
    this.detent = num(this.getAttribute('detent'), 0);
    this.defaultValue = num(this.getAttribute('value'), 0);
    this._value = this.defaultValue;

    const ticks = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * 360;
      const long = i % 6 === 0;
      return `<line class="dial__tick${long ? ' dial__tick--major' : ''}"
        x1="50" y1="${long ? 5 : 8}" x2="50" y2="${long ? 13 : 12}"
        transform="rotate(${a} 50 50)" />`;
    }).join('');

    this.innerHTML = `
      <div class="dial">
        <div class="dial__label">${this.getAttribute('label') || ''}</div>
        <svg class="dial__face" viewBox="0 0 100 100" role="slider" tabindex="0"
             aria-label="${this.getAttribute('label') || 'dial'}"
             aria-valuemin="${this.min}" aria-valuemax="${this.max}" aria-valuenow="${this._value}">
          <circle class="dial__ring" cx="50" cy="50" r="46" />
          <g class="dial__ticks">${ticks}</g>
          <g class="dial__knob">
            <circle class="dial__cap" cx="50" cy="50" r="30" />
            <line class="dial__pointer" x1="50" y1="50" x2="50" y2="24" />
            <circle class="dial__pin" cx="50" cy="50" r="3" />
          </g>
        </svg>
        <output class="dial__value"></output>
      </div>`;

    this.face = this.querySelector('.dial__face');
    this.knob = this.querySelector('.dial__knob');
    this.output = this.querySelector('.dial__value');

    this.face.addEventListener('pointerdown', (e) => this.onDown(e));
    this.face.addEventListener('keydown', (e) => this.onKey(e));
    this.face.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.commit(this._value - Math.sign(e.deltaY) * this.step * (e.shiftKey ? 1 : 10));
    }, { passive: false });
    this.face.addEventListener('dblclick', () => this.commit(this.defaultValue));

    this.sync();
  }

  onDown(event) {
    event.preventDefault();
    this.face.setPointerCapture(event.pointerId);
    const rect = this.face.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angleAt = (e) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;

    let last = angleAt(event);
    let accumulated = this._value;

    const move = (e) => {
      const now = angleAt(e);
      let delta = now - last;
      // Unwrap across the -180/180 seam so a full turn keeps counting.
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      last = now;
      accumulated += delta * (e.shiftKey ? 0.25 : 1);
      this.commit(accumulated, !e.shiftKey);
    };
    const up = () => {
      this.face.releasePointerCapture(event.pointerId);
      this.face.removeEventListener('pointermove', move);
      this.face.removeEventListener('pointerup', up);
      this.face.removeEventListener('pointercancel', up);
      this.dispatchEvent(new Event('change', { bubbles: true }));
    };
    this.face.addEventListener('pointermove', move);
    this.face.addEventListener('pointerup', up);
    this.face.addEventListener('pointercancel', up);
  }

  onKey(event) {
    const big = event.shiftKey ? 10 : 1;
    const map = {
      ArrowLeft: -this.step * big,
      ArrowDown: -this.step * big,
      ArrowRight: this.step * big,
      ArrowUp: this.step * big,
      Home: this.min - this._value,
      End: this.max - this._value,
    };
    if (!(event.key in map)) return;
    event.preventDefault();
    this.commit(this._value + map[event.key]);
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** @param {boolean} snap allow detents to grab nearby values */
  commit(next, snap = true) {
    let v = Math.max(this.min, Math.min(this.max, next));
    if (snap && this.detent > 0) {
      const nearest = Math.round(v / this.detent) * this.detent;
      if (Math.abs(v - nearest) < this.detent * 0.04) v = nearest;
    }
    v = Math.round(v / this.step) * this.step;
    if (v === this._value) return;
    this._value = v;
    this.sync();
    this.dispatchEvent(new Event('input', { bubbles: true }));
  }

  sync() {
    this.knob.setAttribute('transform', `rotate(${this._value} 50 50)`);
    this.output.textContent = formatValue(this._value, this);
    this.face.setAttribute('aria-valuenow', String(this._value));
    this.face.setAttribute('aria-valuetext', this.output.textContent);
  }

  get value() {
    return this._value;
  }

  set value(v) {
    const clamped = Math.max(this.min, Math.min(this.max, num(v, this.defaultValue)));
    if (clamped === this._value) return;
    this._value = clamped;
    if (this.rendered) this.sync();
  }

  reset() {
    this.value = this.defaultValue;
  }
}

/** <ink-switch label checked>: a flip switch over a real checkbox. */
class InkSwitch extends HTMLElement {
  connectedCallback() {
    if (this.rendered) return;
    this.rendered = true;
    this.defaultChecked = this.hasAttribute('checked');
    const id = this.id ? `${this.id}-input` : '';
    this.innerHTML = `
      <label class="switch">
        <input type="checkbox"${id ? ` id="${id}"` : ''}${this.defaultChecked ? ' checked' : ''}>
        <span class="switch__body"><span class="switch__lever"></span></span>
        <span class="switch__label">${this.getAttribute('label') || ''}</span>
      </label>`;
    this.input = this.querySelector('input');
  }

  get checked() {
    return !!this.input?.checked;
  }

  set checked(v) {
    if (this.input) this.input.checked = !!v;
  }

  reset() {
    this.checked = this.defaultChecked;
  }
}

/**
 * <ink-lever label>
 * The develop lever. It is a button; the travel is theatre, but the `pulled`
 * class is what the animation hangs off.
 */
class InkLever extends HTMLElement {
  connectedCallback() {
    if (this.rendered) return;
    this.rendered = true;
    this.innerHTML = `
      <button class="lever" type="button">
        <span class="lever__slot"><span class="lever__handle"></span></span>
        <span class="lever__text">${this.getAttribute('label') || 'Develop'}</span>
      </button>`;
    this.button = this.querySelector('button');
    this.button.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('pull', { bubbles: true }));
    });
  }

  set busy(v) {
    this.classList.toggle('is-pulled', !!v);
    if (this.button) this.button.disabled = !!v;
  }

  set disabled(v) {
    if (this.button) this.button.disabled = !!v;
  }
}

export function defineElements() {
  if (customElements.get('ink-fader')) return;
  customElements.define('ink-fader', InkFader);
  customElements.define('ink-dial', InkDial);
  customElements.define('ink-switch', InkSwitch);
  customElements.define('ink-lever', InkLever);
}
