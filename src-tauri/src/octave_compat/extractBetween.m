function out = extractBetween(s, a, b)
  % BridgeDeck fill-in for MATLAB's extractBetween (the first match).
  out = extractBefore(extractAfter(s, a), b);
end
