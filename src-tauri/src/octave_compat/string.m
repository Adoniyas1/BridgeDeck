function s = string(x)
  % BridgeDeck fill-in: Octave has no string type, so this gives MATLAB-like text (char).
  if ischar(x) || iscellstr(x), s = x;
  elseif isnumeric(x) || islogical(x)
    if isscalar(x), s = num2str(x); else, s = arrayfun(@num2str, x, 'UniformOutput', false); end
  else, s = disp(x);
  end
end
