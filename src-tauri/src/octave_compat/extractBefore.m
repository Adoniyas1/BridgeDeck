function out = extractBefore(s, pat)
  % BridgeDeck fill-in for MATLAB's extractBefore (a position or text).
  if isnumeric(pat), out = s(1:pat-1); return; end
  k = strfind(s, pat);
  if isempty(k), out = ''; else, out = s(1:k(1)-1); end
end
