// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
// Monetary inputs are finite JSON numbers. Use their decimal spelling so that
// half cents and sums of sub-cent ticks survive both arithmetic and a restart.
'use strict';

function decimalParts(value) {
  const [mantissa, power = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  return { digits, places: fraction.length - Number(power) };
}

function addDecimal(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const places = Math.max(0, a.places, b.places);
  const sum = a.digits * 10n ** BigInt(places - a.places) +
              b.digits * 10n ** BigInt(places - b.places);
  if (!places) return String(sum);
  const digits = String(sum < 0n ? -sum : sum).padStart(places + 1, '0');
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return (sum < 0n ? '-' : '') + digits.slice(0, -places) + (fraction ? '.' + fraction : '');
}

function cents(value, roundDown = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value * 100)) return value * 100;
  const { digits, places } = decimalParts(value);
  if (places <= 2) return Number(digits * 10n ** BigInt(2 - places));
  const divisor = 10n ** BigInt(places - 2);
  const whole = digits / divisor;
  const remainder = digits % divisor;
  if (roundDown) return Number(remainder < 0n ? whole - 1n : whole);
  if (remainder * 2n >= divisor) return Number(whole + 1n);
  if (remainder * 2n < -divisor) return Number(whole - 1n);
  return Number(whole);
}

function validVip(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
         !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
}

// The wire format requires a calendar date and a time zone. Date.parse alone
// accepts local dates and normalizes impossible dates such as February 30.
function determinationTime(value) {
  if (typeof value !== 'string') return NaN;
  const m = /^(\d{4})-(\d\d)-(\d\d)[tT](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!m) return NaN;
  const date = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.getUTCDate() !== Number(m[3])) return NaN;
  return Date.parse(value);
}

module.exports = { addDecimal, cents, validVip, determinationTime };
