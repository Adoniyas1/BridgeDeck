function s = strip(s, side, ch)
  % BridgeDeck fill-in for MATLAB's strip.
  if nargin < 2, side = 'both'; end
  if nargin < 3
    trimL = @(x) regexprep(x, '^\s+', ''); trimR = @(x) regexprep(x, '\s+$', '');
  else
    c = regexptranslate('escape', ch);
    trimL = @(x) regexprep(x, ['^(' c ')+'], ''); trimR = @(x) regexprep(x, ['(' c ')+$'], '');
  end
  switch lower(side)
    case 'left', f = trimL;
    case 'right', f = trimR;
    otherwise, f = @(x) trimR(trimL(x));
  end
  if iscell(s), s = cellfun(f, s, 'UniformOutput', false); else, s = f(s); end
end
