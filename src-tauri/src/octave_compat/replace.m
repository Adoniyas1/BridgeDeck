function s = replace(s, old, new)
  % BridgeDeck fill-in for MATLAB's replace.
  if ~iscell(old), old = {old}; end
  if ~iscell(new), new = repmat({new}, size(old)); end
  for k = 1:numel(old), s = strrep(s, old{k}, new{k}); end
end
