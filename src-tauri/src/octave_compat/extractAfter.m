function out = extractAfter(s, pat)
  % BridgeDeck fill-in for MATLAB's extractAfter (a position or text).
  if isnumeric(pat), out = s(pat+1:end); return; end
  k = strfind(s, pat);
  if isempty(k), out = ''; else, out = s(k(1)+numel(pat):end); end
end
