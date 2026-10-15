function n = strlength(s)
  % BridgeDeck fill-in for MATLAB's strlength.
  if iscell(s), n = cellfun(@numel, s); else, n = numel(s); end
end
