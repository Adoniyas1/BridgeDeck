function tf = contains(str, pat, varargin)
  % BridgeDeck fill-in for MATLAB's contains (text or a cell array of text).
  ic = numel(varargin) >= 2 && strcmpi(varargin{1}, 'IgnoreCase') && logical(varargin{2});
  if ~iscell(pat), pat = {pat}; end
  if ic, str = lower(str); pat = lower(pat); end
  one = @(s) any(cellfun(@(p) ~isempty(strfind(s, p)), pat));
  if iscell(str), tf = cellfun(one, str); else, tf = one(str); end
end
