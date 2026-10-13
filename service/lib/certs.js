'use strict';

// O `ca` do https no Node 0.12 so le o primeiro certificado de uma string com varios;
// por isso o bundle PEM (certs/cacert.pem) e quebrado em um item por certificado.

var BEGIN = '-----BEGIN CERTIFICATE-----';
var END = '-----END CERTIFICATE-----';

// Devolve cada certificado (de BEGIN a END, mais "\n"); texto entre eles e um ultimo incompleto sao ignorados.
function splitPemBundle(text) {
  var certs = [];
  var from = 0;
  var start;
  var end;
  text = String(text);
  for (;;) {
    start = text.indexOf(BEGIN, from);
    if (start === -1) break;
    end = text.indexOf(END, start + BEGIN.length);
    if (end === -1) break;
    certs.push(text.substring(start, end + END.length) + '\n');
    from = end + END.length;
  }
  return certs;
}

module.exports = { splitPemBundle: splitPemBundle };
